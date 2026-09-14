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
    /*
     * 收起态的入口在**标题栏**（开关位置与面板收放无关，参考 Codex）——
     * 所以这里断言「标题栏那个开关还在、还没动」，而不是找面板内的悬停按钮。
     */
    const toggleNow = box('[data-testid="rail-toggle"]')
    out.push('  收起后标题栏开关 ' + JSON.stringify(toggleNow))
    if (toggleNow && exp && toggleNow.x === exp.x && toggleNow.y === exp.y) ok('收起后开关没动（入口始终在标题栏）')
    else bad('开关位置变了：' + JSON.stringify(exp) + ' → ' + JSON.stringify(toggleNow))
    if (toggleNow && toggleNow.w >= 20) ok('开关有可点尺寸（' + toggleNow.w + 'px）')
    else bad('开关太小：' + JSON.stringify(toggleNow))

    const c2 = box('[data-testid="composer"]')
    out.push('  收起后 composer = ' + JSON.stringify(c2))
    if (visible(c2)) ok('左栏收起后输入框仍可见（' + c2.w + '×' + c2.h + '）')
    else bad('左栏收起后输入框不见了！' + JSON.stringify(c2))
    const centerW2 = box('.center')?.w ?? 0
    out.push('  收起后 center=' + centerW2 + '（展开时 ' + centerW + '）')
    if (centerW2 >= centerW) ok('收起左栏后中栏变宽（推挤式布局正确）')
    else bad('收起后中栏反而变窄：' + centerW + ' → ' + centerW2)

    // 展开回来
    const un = document.querySelector('[data-testid="rail-toggle"]')
    if (un) click(un)
    await until(() => store.getState().railPinned, 3000)
    await sleep(600)

    out.push('\n=== 3. 工具栏收起：开关位置 + 输入框 ===')
    /*
     * 开关在**标题栏右侧**（参考 Codex）—— 它是常驻的，
     * 所以「收起后找不到入口」在结构上就不存在了。
     * 断言：位置在收放前后**完全不变**（这才是「位置对」的定义）。
     */
    const rpExp = box('.titlebar [data-testid="rightpanel-toggle"]')
    out.push('  收起前开关 ' + JSON.stringify(rpExp))
    click(document.querySelector('.titlebar [data-testid="rightpanel-toggle"]'))
    await sleep(700)
    const rpUn = box('.titlebar [data-testid="rightpanel-toggle"]')
    out.push('  收起后开关 ' + JSON.stringify(rpUn) + '  工具栏已卸载=' + !document.querySelector('[data-testid="rightpanel"]'))
    if (!document.querySelector('[data-testid="rightpanel"]')) ok('工具栏已卸载（收起 0 宽）')
    else bad('工具栏还在')
    if (rpUn) {
      const dx = Math.abs((rpUn.x ?? 0) - (rpExp?.x ?? 0))
      const dy = Math.abs((rpUn.y ?? 0) - (rpExp?.y ?? 0))
      out.push('  与收起前的位置差: dx=' + dx + ' dy=' + dy)
      if (dx <= 1 && dy <= 1) ok('工具栏收起后开关**不动**（入口始终在）')
      else bad('开关移动了（dx=' + dx + ' dy=' + dy + '）')
      const maxB = box('[data-testid="win-max"]')
      out.push('  开关 x=' + rpUn.x + '  最大化按钮 x=' + (maxB?.x ?? '?'))
      /* 开关与窗口控制之间还有「置顶」按钮，所以间距约一个按钮宽 */
      const gapToControls = maxB ? maxB.x - (rpUn.x + rpUn.w) : -1
      out.push('  与窗口控制的间距 ' + gapToControls + 'px（中间还有置顶按钮）')
      if (maxB && rpUn.x + rpUn.w <= maxB.x + 2 && gapToControls <= 60) ok('在窗口控制按钮左侧（右侧的唯一入口）')
      else bad('与窗口控制的相对位置不对')
    } else bad('收起后找不到开关')

    out.push('\n=== 4. 两侧都收起（最窄的可用状态）===')
    click(document.querySelector('[data-testid="rail-toggle"]'))
    await sleep(700)
    const c4 = box('[data-testid="composer"]')
    const rw = box('.rail-slot')?.w ?? -1
    /* 右栏收起后连元素都没有，所以量 grid 的第一/第三列 */
    const gridCols = getComputedStyle(document.querySelector('.workspace')).gridTemplateColumns.split(' ')
    const pw = parseFloat(gridCols[gridCols.length - 1])
    out.push('  rail=' + rw + ' right=' + pw + ' composer=' + JSON.stringify(c4))
    if (visible(c4)) ok('两侧都收起时输入框仍在（' + c4.w + '×' + c4.h + '）')
    else bad('两侧收起后输入框不见了！')
    /*
     * ⚠️ 2026-09 评审后设计变过：收起态从「 0 宽、入口只在标题栏」
     *    改成「48px 紧凑快捷轨（.rail-compact，带 bg-1 底色）」。
     *    下面这两条原来写的是**旧设计**（必须 0 宽 / 必须透明），
     *    在新设计下它们是错的 —— 那是过时断言，不是回归。
     *    现在改为验证新设计真正在意的事：紧凑轨宽度稳定、
     *    里面的入口可见可点，而右栏收起后是真的卸载。
     */
    const compactBtns = [...document.querySelectorAll('.rail-compact button')]
    const compactVisible = compactBtns.some((b) => b.getBoundingClientRect().width > 0)
    out.push(`  收起后：rail=${rw}px 紧凑轨按钮=${compactBtns.length} 个（可见=${compactVisible}） panel=${pw}px`)
    if (rw === 48 && compactBtns.length > 0 && compactVisible) {
      ok('左栏收起为 48px 紧凑轨，且有可见可点的快捷入口')
    } else {
      bad(`左栏收起态不对：宽 ${rw}px，紧凑按钮 ${compactBtns.length} 个（可见=${compactVisible}）`)
    }
    if (pw === 0) ok('右栏收起后 0 宽（整个卸载，不占位）')
    else bad('右栏收起后仍有保留宽度：' + pw)

    // 复位
    store.getState().setRailPinned(true)
    if (!store.getState().settings?.rightPanelOpen) await store.getState().toggleRightPanel()
  } catch (e) { bad('抛异常：' + (e && e.message ? e.message : String(e))) }
  out.push('')
  const failed = out.filter((l) => l.includes('✗')).length
  out.push(failed === 0 ? '[narrow] 全部通过' : '[narrow] ' + failed + ' 条失败')
  return out.join('\n')
})()
