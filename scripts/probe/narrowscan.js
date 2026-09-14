/**
 * 布局宽度扫描：不同窗口尺寸下，三栏各占多少、对话区还剩多少。
 *
 * 用于给 P0-2「窄屏规则」取基线数据（方案 3.2 要求断点由实机测量确定，
 * 不拍脑袋写死）。只做测量 + 一条最小可用宽度断言，不改任何东西。
 *
 * 由 test-live 的 wins 跑多档，每档一个独立进程。
 */
;(async () => {
  const out = []
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const store = window.__yanStore
  const px = (v) => (v === undefined || v === null ? '-' : Math.round(v))
  const box = (sel) => {
    const e = document.querySelector(sel)
    if (!e) return null
    const r = e.getBoundingClientRect()
    const cs = getComputedStyle(e)
    if (cs.display === 'none' || cs.visibility === 'hidden') return { w: 0, h: 0, x: 0, hidden: true }
    return { w: r.width, h: r.height, x: r.x }
  }

  try {
    const root = document.documentElement
    const cs = getComputedStyle(root)

    out.push(`  视口 ${window.innerWidth}×${window.innerHeight}  DPR ${devicePixelRatio}`)
    out.push(
      `  媒体查询 max-900=${window.matchMedia('(max-width: 900px)').matches} ` +
        `max-980=${window.matchMedia('(max-width: 980px)').matches} ` +
        `max-1180=${window.matchMedia('(max-width: 1180px)').matches}`
    )
    out.push(
      `  令牌 --w-rail=${cs.getPropertyValue('--w-rail').trim() || '(空)'} ` +
        `--w-right=${cs.getPropertyValue('--w-right').trim() || '(空)'} ` +
        `--w-rail-user=${cs.getPropertyValue('--w-rail-user').trim() || '(未设)'}`
    )

    const report = (label) => {
      const rail = box('.rail-slot')
      const railInner = box('.rail')
      const center = box('.center')
      const right = box('.rightpanel')
      const composer = box('[data-testid="composer"]')
      const stream = box('.stream')
      const over = root.scrollWidth - root.clientWidth
      out.push(`  ${label}`)
      out.push(`    rail=${px(rail?.w)}${rail?.hidden ? '(hidden)' : ''} center=${px(center?.w)} right=${px(right?.w)}`)
      out.push(
        `    .rail 内容=${railInner?.hidden ? 'HIDDEN(display:none)' : '可见'} w=${px(railInner?.w)} ` +
          `composer=${px(composer?.w)} stream=${px(stream?.w)} 横向溢出=${over}px`
      )
      const okComposer = !!composer && composer.w >= 320
      out.push(`    ${okComposer ? '✓' : '✗'} 对话输入区可用宽度（${px(composer?.w)}，期望 ≥320）`)
      out.push(`    ${over <= 0 ? '✓' : '✗'} 无横向溢出`)
      if (rail?.w > 60 && railInner?.hidden) out.push('    ✗ 左栏占位但内容被 display:none 隐藏（白白吃掉宽度）')
    }

    /* ① 左栏展开 + 右栏开 */
    store.getState().setRailPinned(true)
    if (!store.getState().settings?.rightPanelOpen) await store.getState().toggleRightPanel()
    await sleep(700)
    report('① 左栏展开 / 右栏开')

    /* ② 左栏收起（紧凑轨） */
    store.getState().setRailPinned(false)
    await sleep(500)
    report('② 左栏收起 / 右栏开')

    /* ③ 右栏也收起（最窄可用态） */
    await store.getState().toggleRightPanel()
    await sleep(500)
    report('③ 左栏收起 / 右栏关')

    /* ④ 恢复左栏展开、右栏关 —— 用户回到宽屏时的常见组合 */
    store.getState().setRailPinned(true)
    await sleep(500)
    report('④ 左栏展开 / 右栏关')
  } catch (error) {
    out.push('  扫描出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
