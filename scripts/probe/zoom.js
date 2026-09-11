/**
 * 界面缩放：DPI 感知 + 手动档位 + 快捷键 + 设置面板。
 *
 * 为什么必须在这个文件里测（而不是纯逻辑单测）：
 *   纯逻辑（zoom-math.ts）用 test-zoom.mjs 测了取整公式，
 *   但「真实按键能不能改到缩放」这条路只能在这里测 ——
 *   Ctrl+= 是**主进程**用 before-input-event 拦的，
 *   合成 KeyboardEvent 不走那条路（见 index.ts 的说明）。
 *   所以这个场景带 keys（真实 sendInputEvent）。
 *
 * 本次实测抓到的两个真 bug（都已修，断言留着防回归）：
 *   ① 从自动值 1.152 按 Ctrl+- 只降到 1.15（差 0.2%，像没反应）
 *      → stepScaleFrom 加了「最小有效步长 4%」
 *   ② i18n 占位符写成 {{v}} 双花括号 → 界面上显示成「自动（{1.15}×）」
 */
;(async () => {
  const out = []
  const ok = (m) => out.push('  ✓ ' + m)
  const bad = (m) => out.push('  ✗ ' + m)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const store = window.__yanStore

  try {
    out.push('=== 真实按键：Ctrl+= / Ctrl+= / Ctrl+- / Ctrl+0 ===')
    /*
     * 记录 effective 的变化序列。
     *
     * ⚠️ 轮询到条件成立，**不用固定 10 秒窗口** —— 这是本项目的硬约定
     *    （HANDOFF：'探针不要用固定 sleep 等 UI，负载高时不够'）。
     *    上一版就是固定 10s：在被前一个场景拖慢时，最后一下 Ctrl+0 还没到
     *    采样就结束了，报成「没回到自动」。这类假失败浪费过时间。
     *
     * 结束条件：已经观察到 ≥4 次变化 **且** 末值回到自动；超时 30s 兜底。
     */
    const seq = []
    let prev = null
    const t0 = Date.now()
    const DEADLINE = 30000
    while (Date.now() - t0 < DEADLINE) {
      const z = await window.yan.getZoom()
      const v = Number(z.effective.toFixed(4))
      if (v !== prev) {
        seq.push({ t: Date.now() - t0, v, ui: z.uiScale })
        prev = v
      }
      const done = seq.length >= 4 && seq[seq.length - 1].ui === 0
      if (done) break
      await sleep(120)
    }
    out.push('  观察用时 ' + (Date.now() - t0) + 'ms，变化 ' + seq.length + ' 次')
    out.push('  变化序列（毫秒 → 生效倍率，uiScale）：')
    for (const s of seq) out.push('    t=' + String(s.t).padStart(5) + 'ms  ' + s.v.toFixed(3) + '×  uiScale=' + s.ui)

    const vals = seq.map((s) => s.v)
    const auto = vals[0]
    if (auto > 1.05) ok('起点是自动值 ' + auto.toFixed(3))
    else bad('起点异常：' + auto)

    const idx = (v) => vals.findIndex((x) => Math.abs(x - v) < 1e-6)
    if (idx(1.3) > 0) ok('Ctrl+= 放大到 1.3（自动 ' + auto.toFixed(3) + ' 的上一档）')
    else bad('Ctrl+= 没有放大到 1.3，序列=' + JSON.stringify(vals))
    if (idx(1.5) > idx(1.3)) ok('再按 Ctrl+= 到 1.5')
    else bad('第二下 Ctrl+= 没到 1.5')
    const idx15 = vals.findIndex((x) => Math.abs(x - 1.5) < 1e-6)
    const idx13b = vals.findIndex((x, i) => i > idx15 && Math.abs(x - 1.3) < 1e-6)
    if (idx13b > idx15) ok('Ctrl+- 回到 1.3')
    else bad('Ctrl+- 没回到 1.3，序列=' + JSON.stringify(vals))
    if (Math.abs(vals[vals.length - 1] - auto) < 1e-6) ok('Ctrl+0 回到自动 ' + auto.toFixed(3))
    else bad('Ctrl+0 没回到自动，末尾=' + vals[vals.length - 1])

    // 步长可感知
    const d = Math.abs(1.3 - auto) / auto
    if (d > 0.04) ok('一步变化 ' + (d * 100).toFixed(1) + '%（按一下看得出来）')
    else bad('步长太小：' + (d * 100).toFixed(1) + '%')

    // 落盘一致性
    const st = store.getState()
    out.push('  store.settings.uiScale=' + st.settings.uiScale + '  store.zoom.uiScale=' + (st.zoom && st.zoom.uiScale))
    if (st.settings.uiScale === 0 && st.zoom.uiScale === 0) ok('快捷键改完，设置状态与主进程一致（都回自动）')
    else bad('状态不一致')

    // 界面上的选中态（设置 → 外观）
    const railBtn = document.querySelector('[data-testid="rail-settings"]')
    if (railBtn) {
      railBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await sleep(500)
      const appTab = [...document.querySelectorAll('.settings-tab')].find((x) => /外观/.test(x.textContent))
      if (appTab) {
        appTab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        await sleep(700)
        const ctl = document.querySelector('[data-testid="set-ui-scale"]')
        if (!ctl) bad('外观页没有缩放控件')
        else {
          const btns = [...ctl.querySelectorAll('button')]
          out.push('  档位文案：' + btns.map((b) => b.textContent.trim()).join(' / '))
          // 占位符必须真的被替换
          const joined = btns.map((b) => b.textContent).join(' ')
          if (!/\{[a-zA-Z]+\}/.test(joined)) ok('档位文案里没有未替换的占位符')
          else bad('占位符没被替换：' + joined)
          const rowText = ctl.parentElement.parentElement.textContent.replace(/\s+/g, ' ')
          const m = rowText.match(/屏幕[^·]*·[^·]*·[^·]*/)
          out.push('  数值行：' + (m ? m[0].trim() : rowText.slice(0, 80)))
          if (!/\{[a-zA-Z]+\}/.test(rowText)) ok('说明文案里没有未替换的占位符')
          else bad('说明文案占位符未替换')
          const sel = btns.filter((b) => b.classList.contains('sel')).map((b) => b.textContent.trim())
          if (sel.some((x) => /自动/.test(x))) ok('「自动」档显示为选中（与快捷键结果一致）')
          else bad('选中态不对：' + JSON.stringify(sel))
          const close = [...document.querySelectorAll('.settings-tab')].find((x) => /关闭/.test(x.textContent))
          if (close) close.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        }
      } else bad('找不到外观 tab')
    } else bad('找不到设置入口')
  } catch (e) {
    bad('抛异常：' + (e && e.message ? e.message : String(e)))
  }

  out.push('')
  const failed = out.filter((l) => l.includes('✗')).length
  out.push(failed === 0 ? '[zoomkeys] 全部通过' : '[zoomkeys] ' + failed + ' 条失败')
  return out.join('\n')
})()
