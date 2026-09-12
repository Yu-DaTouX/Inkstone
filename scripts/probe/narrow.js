/**
 * 窄窗口 + 面板收起态：布局是否还可用。
 *
 * 用户报的三个 bug 都在这个交集里：
 *   ① 左栏收起后，展开按钮有 bug
 *   ② 左栏未展开时输入框消失
 *   ③ 右栏展开按钮位置不对
 * 所以这个探针只在窄窗口跑（YAN_WIN 控制），并且两种收起状态都量。
 */
;(async () => {
  const out = []
  const ok = (m) => out.push('  ✓ ' + m)
  const bad = (m) => out.push('  ✗ ' + m)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const until = async (fn, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(80) } return false }
  const store = window.__yanStore
  const box = (sel) => {
    const e = document.querySelector(sel)
    if (!e) return null
    const r = e.getBoundingClientRect()
    const cs = getComputedStyle(e)
    return { x: +r.x.toFixed(0), y: +r.y.toFixed(0), w: +r.width.toFixed(0), h: +r.height.toFixed(0), vis: cs.visibility, disp: cs.display }
  }
  const visible = (b) => !!b && b.disp !== 'none' && b.vis !== 'hidden' && b.w > 0 && b.h > 0

  try {
    localStorage.setItem('yan.onboarded', '1')
    for (let i = 0; i < 25; i++) { const c = document.querySelector('.ob-card'); if (!c) break
      const b = [...c.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent)); if (b) { click(b); await sleep(300) } else await sleep(150) }
    store.getState().setRailPinned(true)
    if (!store.getState().settings?.rightPanelOpen) await store.getState().toggleRightPanel()
    await sleep(800)

    out.push('=== 0. 环境 ===')
    out.push('  窗口 ' + window.innerWidth + '×' + window.innerHeight + '  设备像素比 ' + devicePixelRatio)
    const centerW = box('.center')?.w ?? 0
    out.push('  三栏: rail=' + (box('.rail-slot')?.w ?? 0) + ' center=' + centerW + ' right=' + (box('.rightpanel, .rightstub')?.w ?? 0))
    if (centerW > 260) ok('中栏还有可用宽度（' + centerW + 'px）')
    else bad('中栏被挤到 ' + centerW + 'px（输入框会看不见）')

    out.push('\n=== 1. 展开态：输入框必须在 ===')
    const c1 = box('[data-testid="composer"]')
    out.push('  composer = ' + JSON.stringify(c1))
    if (visible(c1)) ok('输入框可见（' + c1.w + '×' + c1.h + '）')
    else bad('输入框不可见！' + JSON.stringify(c1))

    out.push('\n=== 2. 左栏收起：按钮位置 + 输入框 ===')
    const exp = box('[data-testid="rail-toggle"]')
    out.push('  展开态开关 ' + JSON.stringify(exp))
    click(document.querySelector('[data-testid="rail-toggle"]'))
    await sleep(700)
    const unhide = box('[data-testid="rail-expand"]')
    out.push('  收起态入口 ' + JSON.stringify(unhide))
    if (unhide) {
      // 与展开态同一个位置吗（用户报「不对齐」）
      const dx = Math.abs((unhide.x ?? 0) - (exp?.x ?? 0))
      const dy = Math.abs((unhide.y ?? 0) - (exp?.y ?? 0))
      out.push('  与展开态的位置差: dx=' + dx + ' dy=' + dy)
      if (dx <= 2 && dy <= 2) ok('收起态入口与展开态开关对齐')
      else bad('入口位置偏了（dx=' + dx + ' dy=' + dy + '）')
      if (unhide.w >= 6) ok('入口有可点宽度（' + unhide.w + 'px）')
      else bad('入口太窄点不到：' + unhide.w)
      // 悬停时按钮本体要出来（8px 的缝放不下 22px 图标）
      const ico = box('[data-testid="rail-expand"] .ico')
      out.push('  图标本体 ' + JSON.stringify(ico))
      if (ico && ico.w >= 18) ok('图标本体有尺寸（悬停可显示）')
      else bad('图标本体尺寸不对：' + JSON.stringify(ico))
    } else bad('收起后找不到展开入口')

    const c2 = box('[data-testid="composer"]')
    out.push('  收起后 composer = ' + JSON.stringify(c2))
    if (visible(c2)) ok('左栏收起后输入框仍可见（' + c2.w + '×' + c2.h + '）')
    else bad('左栏收起后输入框不见了！' + JSON.stringify(c2))
    const centerW2 = box('.center')?.w ?? 0
    out.push('  收起后 center=' + centerW2 + '（展开时 ' + centerW + '）')
    if (centerW2 >= centerW) ok('收起左栏后中栏变宽（推挤式布局正确）')
    else bad('收起后中栏反而变窄：' + centerW + ' → ' + centerW2)

    // 展开回来
    const un = document.querySelector('[data-testid="rail-expand"]')
    if (un) click(un)
    await until(() => store.getState().railPinned, 3000)
    await sleep(600)

    out.push('\n=== 3. 右栏收起：按钮位置 + 输入框 ===')
    const rpExp = box('[data-testid="rightpanel-hide"]')
    out.push('  展开态开关 ' + JSON.stringify(rpExp))
    click(document.querySelector('[data-testid="rightpanel-hide"]'))
    await sleep(700)
    const rpUn = box('[data-testid="rightpanel-toggle"]')
    out.push('  收起态入口 ' + JSON.stringify(rpUn))
    if (rpUn) {
      const dx = Math.abs((rpUn.x ?? 0) - (rpExp?.x ?? 0))
      const dy = Math.abs((rpUn.y ?? 0) - (rpExp?.y ?? 0))
      out.push('  与展开态的位置差: dx=' + dx + ' dy=' + dy)
      if (dx <= 3 && dy <= 3) ok('右栏收起态入口与展开态开关对齐')
      else bad('右栏入口位置偏了（dx=' + dx + ' dy=' + dy + '）')
      // 必须贴右边缘（用户报「位置不对」）
      const fromRight = window.innerWidth - ((rpUn.x ?? 0) + rpUn.w)
      out.push('  距窗口右边缘 ' + fromRight + 'px')
      if (Math.abs(fromRight - 8) <= 6 || fromRight <= 14) ok('贴在窗口右边缘（' + fromRight + 'px）')
      else bad('入口没有贴右边缘，离了 ' + fromRight + 'px')
    } else bad('右栏收起后找不到展开入口')

    const c3 = box('[data-testid="composer"]')
    if (visible(c3)) ok('右栏收起后输入框仍可见')
    else bad('右栏收起后输入框不见了')

    out.push('\n=== 4. 两侧都收起（最窄的可用状态）===')
    click(document.querySelector('[data-testid="rail-toggle"]'))
    await sleep(700)
    const c4 = box('[data-testid="composer"]')
    const rw = box('.rail-slot')?.w ?? -1
    const pw = box('.rightstub')?.w ?? -1
    out.push('  rail=' + rw + ' right=' + pw + ' composer=' + JSON.stringify(c4))
    if (visible(c4)) ok('两侧都收起时输入框仍在（' + c4.w + '×' + c4.h + '）')
    else bad('两侧收起后输入框不见了！')
    /*
     * 收起槽 = 38px（= 12 + 26，恰好让入口按钮落在展开态的同一坐标）。
     * 「没有条」是**视觉**性质（透明 + 无边框），不是宽度小 ——
     * 窄到 8px 时按钮只能错位，而那正是用户报过的「不对齐」。
     */
    const bgOf = (sel) => {
      const e = document.querySelector(sel)
      return e ? getComputedStyle(e).backgroundColor : '?'
    }
    out.push('  收起槽背景 rail=' + bgOf('.rail') + ' right=' + bgOf('.rightstub'))
    const noBar = [bgOf('.rail'), bgOf('.rightstub')].every(
      (c) => c === 'rgba(0, 0, 0, 0)' || c === 'transparent'
    )
    if (noBar) ok('两侧收起后都没有可见的条（透明）')
    else bad('收起后还能看到条')
    if (rw > 0 && rw <= 40 && pw > 0 && pw <= 40) ok('两条槽都很窄（' + rw + ' / ' + pw + 'px）')
    else bad('收起槽宽度不对：' + rw + ' / ' + pw)

    // 复位
    store.getState().setRailPinned(true)
    if (!store.getState().settings?.rightPanelOpen) await store.getState().toggleRightPanel()
  } catch (e) { bad('抛异常：' + (e && e.message ? e.message : String(e))) }
  out.push('')
  const failed = out.filter((l) => l.includes('✗')).length
  out.push(failed === 0 ? '[narrow] 全部通过' : '[narrow] ' + failed + ' 条失败')
  return out.join('\n')
})()
