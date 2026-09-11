/**
 * 界面缩放的纯逻辑测试（不启动 Electron）。
 *
 * 为什么值得单独测：这段算法的目的不是「好看」而是**消掉中文发虚**，
 * 判据是一条硬性质 ——
 *
 *     基准字号 × 屏幕缩放 × zoom 必须是整数（设备像素）
 *
 * 这条性质在直觉上很容易写错（我第一版就把它和「zoom 取整」搞混了：
 * zoom 是 1.152 这种小数**没关系**，要取整的是设备像素）。
 * 用几个真实存在的缩放比例把它钉住，比在界面上肉眼比对可靠。
 */

/** 允许的浮点误差（12.5 × 1.25 × 1.152 这种连乘会有 1e-15 级误差） */
const EPS = 1e-9
const isInt = (x) => Math.abs(x - Math.round(x)) < 1e-6

const SCALE_FACTORS = [1, 1.25, 1.5, 1.75, 2]

export async function runZoomTests(ok) {
  const m = await import('../out/test/zoom-math.mjs')

  /* -------------------------------------------------- 15. 自动缩放的核心性质 */

  console.log('\n--- 15. 界面缩放（DPI 取整）---')

  for (const sf of SCALE_FACTORS) {
    const z = m.autoZoom(sf)
    const device = m.BASE_FS * sf * z
    ok(
      isInt(device),
      `缩放 ${Math.round(sf * 100)}%：正文落在整数设备像素`,
      `${m.BASE_FS} × ${sf} × ${z.toFixed(6)} = ${device.toFixed(4)} → ${Math.round(device)}`
    )
    ok(
      m.BASE_FS * z >= m.BASE_FS - EPS,
      `缩放 ${Math.round(sf * 100)}%：不小于设计尺寸`,
      `正文 ${(m.BASE_FS * z).toFixed(2)}px 逻辑`
    )
  }

  /* 这一条是「太小」这个抱怨的直接判据：必须**明显**大于设计基准 */
  {
    const z = m.autoZoom(1)
    ok(z > 1.05, '自动模式比设计基准明显大一档（不是只对齐像素的 2% 抖动）', `zoom=${z.toFixed(4)}`)
  }

  /* 与硬编码的回归基线对齐（用户这台就是 125%） */
  {
    const z = m.autoZoom(1.25)
    ok(Math.abs(z - 1.152) < 1e-6, '125% 屏 → 1.152×（回归基线）', `实际 ${z.toFixed(6)}`)
    ok(Math.abs(m.BASE_FS * 1.25 * z - 18) < 1e-6, '125% 屏 → 正文 18 设备像素（原为 15.625）')
  }

  /* 脏输入不能把界面撑爆 */
  {
    for (const bad of [NaN, Infinity, -1, 'abc', undefined, null]) {
      const z = m.autoZoom(bad)
      ok(Number.isFinite(z) && z > 0, `autoZoom(${String(bad)}) 回落到有限正值`, `→ ${z.toFixed(4)}`)
    }
  }

  /* -------------------------------------------------- 16. 手动档位与夹取 */

  console.log('\n--- 16. 手动档位 ---')

  ok(m.clampScale(0) === 0, '0 = 自动（不被夹成最小值）')
  ok(m.clampScale(1.5) === 1.5, '合法值原样返回')
  ok(m.clampScale(99) === m.SCALE_MAX, '过大夹到上限', `${m.SCALE_MAX}`)
  ok(m.clampScale(0.01) === m.SCALE_MIN, '过小夹到下限', `${m.SCALE_MIN}`)
  ok(m.clampScale(-2) === m.SCALE_MIN, '负数不被当成「自动」')
  ok(m.clampScale(NaN) === 0, '脏值回落到自动（而不是某个随机档）')
  ok(m.clampScale('1.3') === 1.3, '字符串数字能接受（设置文件可能是手改的）')

  /* 手动优先于自动 */
  {
    ok(Math.abs(m.effectiveZoom(1.5, 1.25) - 1.5) < EPS, '手动值优先于自动')
    ok(
      Math.abs(m.effectiveZoom(0, 1.25) - m.autoZoom(1.25)) < EPS,
      'uiScale=0 时用自动值'
    )
  }

  /* -------------------------------------------------- 17. 快捷键梯子 */

  console.log('\n--- 17. 快捷键梯子 ---')

  {
    // 自动模式在 125% 下是 1.152 —— 往上应该是 1.3，往下应该是 1.0。
    // ⚠️ 往回不能降到 1.15（只差 0.2%，用户会以为没反应）—— 这一条是回归断言。
    const cur = m.autoZoom(1.25)
    const up = m.stepScaleFrom(cur, 1)
    ok(up > cur, '从自动值往上走是放大', `${cur.toFixed(3)} → ${up}`)
    ok(up === 1.3, '125% 自动（1.152）的上一档是 1.3')

    const down = m.stepScaleFrom(cur, -1)
    ok(down < cur, '往下走是缩小', `${cur.toFixed(3)} → ${down}`)
    ok(down === 1, '125% 自动（1.152）的下一档是 1.0（跳过只差 0.2% 的 1.15）')
    ok(
      (cur - down) / cur > 0.04,
      '一步的变化量 >4%（按一下看得出来）',
      `${(((cur - down) / cur) * 100).toFixed(1)}%`
    )
  }

  /* 梯子两端不能返回 undefined / 越界 */
  {
    const top = m.stepScaleFrom(m.SCALE_MAX, 1)
    ok(top === m.SCALE_MAX, '已到顶再按放大 → 停在上限', `${top}`)
    const bottom = m.stepScaleFrom(m.SCALE_MIN, -1)
    ok(bottom === m.SCALE_MIN, '已到底再按缩小 → 停在下限', `${bottom}`)
  }

  /* 在梯子上走一圈能回到起点（可逆） */
  {
    let v = 1
    for (let i = 0; i < 3; i++) v = m.stepScaleFrom(v, 1)
    for (let i = 0; i < 3; i++) v = m.stepScaleFrom(v, -1)
    ok(Math.abs(v - 1) < 1e-9, '放大 3 档再缩小 3 档回到原档（可逆，无浮点漂移）', `→ ${v}`)
  }

  /* -------------------------------------------------- 18. 状态打包 */

  console.log('\n--- 18. zoomMath 状态 ---')
  {
    const a = m.zoomMath(0, 1.25)
    ok(a.uiScale === 0, 'uiScale=0 表示自动')
    ok(Math.abs(a.effective - a.autoScale) < EPS, '自动模式下 effective === autoScale')
    const b = m.zoomMath(1.3, 1.25)
    ok(b.effective === 1.3, '手动模式下 effective = 手动值')
    ok(Math.abs(b.autoScale - m.autoZoom(1.25)) < EPS, 'autoScale 仍然报告自动值（界面上要显示）')
  }
}
