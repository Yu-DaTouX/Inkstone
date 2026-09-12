/**
 * 面板开关的**位置稳定性**：收起/展开时按钮不能跳。
 *
 * ── 这个场景的目标变过三次，值得说明（否则后来的人会以为断言写错了）──
 *   ① 最初：两个状态复用同一个按钮 → 断言「几何完全相同」
 *   ② 后来开关搬进面板内部 → 收起后必须留槽/悬停入口，断言变成
 *      「收起再展开后按钮回到同一格」
 *   ③ 现在：开关回到**标题栏两端**（用户要求，参考 Codex）→
 *      收起 = 0 宽，开关压根不参与面板收放，所以断言变成最简单的形态：
 *      **收放前后开关的矩形必须完全一致**（它本来就不该动）
 *
 * 这条性质一直没变，变的是「怎么实现」——所以断言也跟着从
 * 「几何相同」收敛成「位置不变」。位置不变是**因**，其它都是从它派生的。
 *
 * 另外保留：收起后入口必须**点得到**（`elementFromPoint` 命中的是它）——
 * 历史上出过「透明左栏盖住入口，按钮存在但点不动」的 bug。
 */
;(async () => {
  const out = []
  const ok = (m) => out.push('  ✓ ' + m)
  const bad = (m) => out.push('  ✗ ' + m)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const store = window.__yanStore

  const rawRect = (sel) => {
    const e = document.querySelector(sel)
    if (!e) return null
    const r = e.getBoundingClientRect()
    return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }
  }
  /** 量到**稳定值**再返回（连读两次相同才算）—— 面板有 120–200ms 过渡 */
  const rect = async (sel) => {
    let prev = rawRect(sel)
    const t0 = Date.now()
    while (Date.now() - t0 < 2500) {
      await sleep(90)
      const cur = rawRect(sel)
      if (!cur) return null
      if (prev && cur.x === prev.x && cur.y === prev.y && cur.w === prev.w && cur.h === prev.h) return cur
      prev = cur
    }
    return prev
  }
  const same = (a, b) => a && b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h

  /** 关掉首次引导层（轮询等它出现再关 —— 不要假设它已经没了） */
  const dismissOnboarding = async () => {
    localStorage.setItem('yan.onboarded', '1')
    for (let i = 0; i < 25; i++) {
      const card = document.querySelector('.ob-card')
      if (!card) return 'none'
      const btn = [...card.querySelectorAll('button')].find((b) => /开始使用|完成|Get started/.test(b.textContent))
      if (btn) click(btn)
      await sleep(200)
    }
    return 'still-open'
  }

  /**
   * 一个面板的往返：量开关 → 收起 → 再量 → 必须一模一样，且入口点得到。
   * `entrySel` 就是标题栏那个开关自己（入口不在面板内部了）。
   */
  const roundTrip = async (label, cfg) => {
    out.push(`\n=== ${label} ===`)
    await cfg.ensureOpen()
    await sleep(600)

    const before = await rect(cfg.btn)
    if (!before) {
      bad(`${label}：找不到标题栏开关`)
      return
    }
    out.push(`  收放前开关 ${JSON.stringify(before)}`)

    click(document.querySelector(cfg.btn))
    await sleep(700)

    const after = await rect(cfg.btn)
    out.push(`  收放后开关 ${JSON.stringify(after)}`)
    if (same(before, after)) ok('开关位置/尺寸完全不变（入口始终在）')
    else bad(`开关跳了：${JSON.stringify(before)} → ${JSON.stringify(after)}`)

    /* 入口必须**真的点得到**：elementFromPoint 看命中的是谁 */
    const hit = document.elementFromPoint(after.x + after.w / 2, after.y + after.h / 2)
    const owner = hit ? hit.closest('button') : null
    out.push(`  elementFromPoint → ${owner ? owner.dataset.testid : String(hit)}`)
    if (owner && owner.dataset.testid === cfg.testId) ok('命中的就是开关（没被别的东西盖住）')
    else bad(`点不到开关，命中 ${owner ? owner.dataset.testid : hit}`)

    if (cfg.unmounted && !document.querySelector(cfg.unmounted)) ok('面板已卸载（收起 = 0 宽）')
    else if (cfg.unmounted) bad('面板还挂着')

    click(owner ?? document.querySelector(cfg.btn))
    await sleep(700)
    const back = await rect(cfg.btn)
    if (same(before, back)) ok('展开后仍在同一格')
    else bad(`展开后位置变了：${JSON.stringify(before)} → ${JSON.stringify(back)}`)
  }

  try {
    const obState = await dismissOnboarding()
    out.push('  引导层: ' + obState)
    if (obState === 'still-open') bad('引导层关不掉，几何测量会量到遮罩')

    await roundTrip('左栏：收起 → 展开', {
      btn: '[data-testid="rail-toggle"]',
      testId: 'rail-toggle',
      ensureOpen: async () => {
        store.getState().setRailPinned(true)
        await sleep(400)
      }
    })

    await roundTrip('工具栏：收起 → 展开', {
      btn: '[data-testid="rightpanel-toggle"]',
      testId: 'rightpanel-toggle',
      unmounted: '[data-testid="rightpanel"]',
      ensureOpen: async () => {
        if (!store.getState().settings?.rightPanelOpen) await store.getState().toggleRightPanel()
        await sleep(400)
      }
    })

    out.push('\n=== 连点 12 次（快速切换不应崩）===')
    for (let i = 0; i < 12; i++) {
      const t = document.querySelector('[data-testid="rail-toggle"]')
      if (t) click(t)
      await sleep(60)
    }
    await sleep(900)
    if (document.querySelector('.app')) ok('页面存活，railPinned=' + store.getState().railPinned)
    else bad('页面没了')
    store.getState().setRailPinned(true)
    if (!store.getState().settings?.rightPanelOpen) await store.getState().toggleRightPanel()
  } catch (e) {
    bad('抛异常：' + (e && e.message ? e.message : String(e)))
  }

  const failed = out.filter((l) => l.includes('✗')).length
  if (failed > 0) {
    out.push('')
    out.push('--- 失败现场 ---')
    const st = store.getState()
    out.push('  railPinned=' + st.railPinned + '  rightPanelOpen=' + st.settings?.rightPanelOpen)
    out.push('  uiScale=' + st.settings?.uiScale)
    const overlays = ['.ob-card', '.settings', '.modal-scrim', '.rail-user-pop', '.tool-lib'].filter((s2) => document.querySelector(s2))
    out.push('  打开的浮层: ' + (overlays.length ? overlays.join(', ') : '（无）'))
  }
  out.push('')
  out.push(failed === 0 ? '[symmetry] 全部通过' : '[symmetry] ' + failed + ' 条失败')
  return out.join('\n')
})()
