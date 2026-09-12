/**
 * 面板开关在**标题栏两端**（用户要求，参考 Codex 截图）。
 *
 * 为什么值得钉住：这两个开关的位置变过三次 ——
 *   ① 标题栏两端 → ② 搬进各自面板内部（“开关贴着它控制的东西”）
 *   → ③ 回到标题栏两端（本次，因为②导致收起态必须保留 38px 的槽，
 *      而那条保留宽度把中栏宽度算错，连带把**导航轨位置带偏**）。
 *
 * 这个场景断言的是「与位置无关的性质」，所以下次再改版也不会假失败：
 *   · 开关在标题栏、分居左右两端
 *   · 面板收放时开关**不动**（这才是「收起后找不到入口」的正解）
 *   · 收起 = 0 宽（不需要留槽）
 *   · 收起状态下导航轨仍贴着正文列（错位 bug 的回归断言）
 *   · 左栏「砚 ⌄」模式菜单：入口在、当前模式可选、其余明确未接入
 */
;(async () => {
  const out = []
  const ok = (m) => out.push('  ✓ ' + m)
  const bad = (m) => out.push('  ✗ ' + m)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const until = async (fn, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(80) } return false }
  const store = window.__yanStore
  const rect = (sel) => {
    const e = document.querySelector(sel)
    if (!e) return null
    const r = e.getBoundingClientRect()
    return { x: +r.x.toFixed(0), y: +r.y.toFixed(0), w: +r.width.toFixed(0), h: +r.height.toFixed(0) }
  }
  const same = (a, b) => a && b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h

  try {
    localStorage.setItem('yan.onboarded', '1')
    for (let i = 0; i < 25; i++) { const c = document.querySelector('.ob-card'); if (!c) break
      const b = [...c.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent)); if (b) { click(b); await sleep(300) } else await sleep(150) }
    store.getState().setRailPinned(true)
    if (!store.getState().settings?.rightPanelOpen) await store.getState().toggleRightPanel()
    await sleep(800)

    out.push('=== 1. 两个开关都在标题栏 ===')
    const rt = document.querySelector('[data-testid="rail-toggle"]')
    const pt = document.querySelector('[data-testid="rightpanel-toggle"]')
    if (rt && rt.closest('.titlebar')) ok('侧栏开关在标题栏里')
    else bad('侧栏开关不在标题栏')
    if (pt && pt.closest('.titlebar')) ok('工具栏开关在标题栏里')
    else bad('工具栏开关不在标题栏')
    // 左右两端（Codex 的位置）：侧栏在左半、工具栏在右半
    const rtr = rect('[data-testid="rail-toggle"]')
    const ptr = rect('[data-testid="rightpanel-toggle"]')
    out.push('  侧栏开关 ' + JSON.stringify(rtr) + '   工具栏开关 ' + JSON.stringify(ptr) + '   窗口宽 ' + window.innerWidth)
    if (rtr && rtr.x < window.innerWidth / 2) ok('侧栏开关在窗口左侧')
    else bad('侧栏开关位置不对')
    if (ptr && ptr.x > window.innerWidth / 2) ok('工具栏开关在窗口右侧')
    else bad('工具栏开关位置不对')
    // 工具栏开关应紧邻窗口控制按钮
    const maxBtn = rect('[data-testid="win-max"]')
    if (ptr && maxBtn && ptr.x < maxBtn.x) ok('工具栏开关在窗口控制按钮左边（挨着）')
    else bad('工具栏开关与窗口控制的相对位置不对')

    out.push('\n=== 2. 开关位置与面板收放**无关** ===')
    const before1 = rect('[data-testid="rail-toggle"]')
    click(rt)
    await sleep(700)
    const after1 = rect('[data-testid="rail-toggle"]')
    out.push('  收起左栏：' + JSON.stringify(before1) + ' → ' + JSON.stringify(after1))
    if (same(before1, after1)) ok('左栏收起后开关**不动**')
    else bad('左栏收起后开关移动了')
    if (!document.querySelector('[data-testid="rail-expand"]')) ok('不再需要收起态的悬停入口（开关就在标题栏）')
    else bad('还留着旧的悬停入口')

    const slotW = rect('.rail-slot')?.w ?? -1
    out.push('  收起后 rail-slot 宽 = ' + slotW)
    if (slotW === 0) ok('收起 = 真的 0 宽（不占位）')
    else bad('收起后仍占 ' + slotW + 'px')

    const ptBefore = rect('[data-testid="rightpanel-toggle"]')
    click(pt)
    await sleep(700)
    const ptAfter = rect('[data-testid="rightpanel-toggle"]')
    out.push('  收起工具栏：' + JSON.stringify(ptBefore) + ' → ' + JSON.stringify(ptAfter))
    if (same(ptBefore, ptAfter)) ok('工具栏收起后开关**不动**')
    else bad('工具栏收起后开关移动了')
    if (!document.querySelector('[data-testid="rightpanel"]')) ok('工具栏已卸载（收起不占位）')
    else bad('工具栏还在')
    const ws = getComputedStyle(document.querySelector('.workspace')).gridTemplateColumns
    out.push('  两侧都收起时 grid = ' + ws)
    if (/^0px /.test(ws.trim()) && / 0px$/.test(ws.trim())) ok('两侧都是 0 宽（中栏拿到全部空间）')
    else bad('收起后仍有保留宽度：' + ws)

    out.push('\n=== 3. 中栏内容与导航轨对齐（之前错位的根因）===')
    // 注入 4 轮，让导航轨渲染
    const fake = []
    for (let i = 1; i <= 4; i++) {
      fake.push({ id: 'u' + i, role: 'user', text: '第 ' + i + ' 问' })
      fake.push({ id: 'a' + i, role: 'assistant', text: '第 ' + i + ' 答' + 'x'.repeat(60) })
    }
    store.getState().applyPush({ ch: 'sync', payload: fake })
    await sleep(900)
    const inner = rect('.stream-inner')
    const tick = rect('.outline-hit')
    const center = rect('.center')
    out.push('  center=' + JSON.stringify(center) + ' inner=' + JSON.stringify(inner) + ' tick=' + JSON.stringify(tick))
    if (inner && tick && center) {
      const gap = (inner.x + 24) - tick.x
      out.push('  刻度距正文 ' + gap.toFixed(0) + 'px')
      if (gap >= 6 && gap <= 34) ok('导航轨贴着小列（不错位）')
      else bad('导航轨离正文 ' + gap.toFixed(0) + 'px')
    }

    // 展开回来
    click(document.querySelector('[data-testid="rail-toggle"]'))
    await until(() => store.getState().railPinned, 3000)
    click(document.querySelector('[data-testid="rightpanel-toggle"]'))
    await until(() => store.getState().settings?.rightPanelOpen, 3000)
    await sleep(600)

    out.push('\n=== 4. 左栏「砚 ⌄」模式菜单（先只做入口）===')
    const mb = document.querySelector('[data-testid="mode-menu-btn"]')
    if (!mb) bad('没有模式菜单入口')
    else {
      out.push('  入口文案: ' + JSON.stringify(mb.textContent.trim()))
      if (/砚/.test(mb.textContent)) ok('软件名仍在入口上（砚 + 箭头）')
      else bad('入口上没有软件名')
      if (mb.querySelector('svg')) ok('带下拉箭头')
      else bad('没有箭头（看不出可点）')
      click(mb)
      const opened = await until(() => document.querySelector('[data-testid="mode-menu"]'), 3000)
      if (opened) ok('点开后出现模式菜单')
      else bad('点不开')
      const items = [...document.querySelectorAll('.rmm-item')].map((x) => x.textContent.trim())
      out.push('  菜单项: ' + JSON.stringify(items))
      if (items.length >= 3) ok('列出了多个模式（' + items.length + ' 个）')
      else bad('模式太少：' + items.length)
      const cur = document.querySelector('.rmm-item.cur')
      out.push('  当前模式: ' + JSON.stringify(cur?.textContent?.trim()))
      if (cur) ok('标出了当前模式')
      else bad('没有当前模式标记')
      const disabled = [...document.querySelectorAll('.rmm-item:disabled')].length
      out.push('  未接入（disabled）: ' + disabled + ' 个')
      if (disabled === items.length - 1) ok('除当前模式外都明确不可选（不做假状态）')
      else bad('未接入项没被禁用：' + disabled + '/' + items.length)
      const foot = document.querySelector('.rmm-foot')?.textContent ?? ''
      if (/尚未接入|即将支持/.test(foot + items.join(''))) ok('文案说明尚未接入')
      else bad('没有说明未接入')
      // 点外面关掉
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      await sleep(300)
      if (!document.querySelector('[data-testid="mode-menu"]')) ok('点外面能关掉')
      else bad('关不掉')
    }
  } catch (e) { bad('抛异常：' + (e && e.message ? e.message : String(e))) }
  out.push('')
  const failed = out.filter((l) => l.includes('✗')).length
  out.push(failed === 0 ? '[topbar] 全部通过' : '[topbar] ' + failed + ' 条失败')
  return out.join('\n')
})()
