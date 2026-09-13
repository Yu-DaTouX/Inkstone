/**
 * 面板宽度拖拽（左栏 / 工具栏）。
 *
 * 为什么值得单独测：这类控件有**四个很容易各自坏掉**的点，
 * 而且坏掉时都「看起来像好了」：
 *   ① 把手在不在正确的一侧（放错边 = 拖反）
 *   ② 拖动方向与视觉是否一致（工具栏是往左变宽）
 *   ③ 拖动中改的是 CSS 变量、松手才落盘 —— 落盘路径要单独验
 *   ④ **拖动中也要夹范围**：不夹会拖出 -9439px，而非法值让
 *      grid-template-columns 整条失效（那一拖完全没反应）
 *
 * 另外验了键盘（separator + 方向键）与双击复原 ——
 * 「只能拖」的控件对键盘用户不可用，是无障碍最常漏的一类。
 */
;(async () => {
  const out = []
  const ok = (m) => out.push('  ✓ ' + m)
  const bad = (m) => out.push('  ✗ ' + m)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const until = async (fn, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(100) } return false }
  const store = window.__yanStore

  /* 真实指针拖拽：pointerdown → move → up（合成 PointerEvent 能走 React 的
     pointer 事件委派，且 setPointerCapture 在真实元素上有效） */
  const drag = async (el, dx) => {
    const r = el.getBoundingClientRect()
    const x0 = r.x + r.width / 2
    const y0 = r.y + r.height / 2
    const mk = (type, x) => new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse',
      isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y0
    })
    el.dispatchEvent(mk('pointerdown', x0))
    await sleep(60)
    for (let i = 1; i <= 10; i++) el.dispatchEvent(mk('pointermove', x0 + (dx * i) / 10))
    await sleep(80)
    el.dispatchEvent(mk('pointerup', x0 + dx))
    await sleep(500)
  }
  const w = (sel) => document.querySelector(sel)?.getBoundingClientRect().width ?? 0
  const qa = (sel) => [...document.querySelectorAll(sel)]

  try {
    localStorage.setItem('yan.onboarded', '1')
    for (let i = 0; i < 25; i++) {
      const c = document.querySelector('.ob-card')
      if (!c) break
      const b = [...c.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent))
      if (b) { click(b); await sleep(300) } else await sleep(150)
    }
    // 显式置为展开态（不假设起始状态）
    store.getState().setRailPinned(true)
    if (!store.getState().settings?.rightPanelOpen) await store.getState().toggleRightPanel()
    await sleep(700)

    out.push('=== 1. 两个把手都存在且在正确的一侧 ===')
    const hr = document.querySelector('[data-testid="resizer-rail"]')
    const hp = document.querySelector('[data-testid="resizer-panel"]')
    if (hr && hp) ok('左右把手都存在')
    else bad('缺把手 rail=' + !!hr + ' panel=' + !!hp)
    if (hr) {
      out.push('  rail 把手 role=' + hr.getAttribute('role') + ' 可聚焦=' + hr.tabIndex)
      if (hr.getAttribute('role') === 'separator' && hr.tabIndex >= 0) ok('是可聚焦的 separator（键盘也能用）')
      else bad('把手不可聚焦 / 语义不对')
      const rr = hr.getBoundingClientRect()
      const slot = document.querySelector('.rail-slot').getBoundingClientRect()
      out.push('  把手 x=' + rr.x.toFixed(0) + ' w=' + rr.width + '  左栏右缘 x=' + slot.right.toFixed(0))
      if (rr.right <= slot.right + 1 && rr.x > slot.right - 12) ok('把手贴在左栏右缘')
      else bad('把手位置不对')
    }

    out.push('\n=== 2. 拖左栏：宽度跟着变 ===')
    const r0 = w('.rail')
    await drag(hr, +90)
    const r1 = w('.rail')
    out.push('  ' + r0 + ' → ' + r1 + '（拖 +90）')
    if (r1 > r0 + 40) ok('右拖变宽')
    else bad('没变宽')
    const persisted = store.getState().settings?.railWidth
    out.push('  落盘 railWidth=' + persisted)
    if (Math.abs(persisted - r1) <= 2) ok('松手后写进了设置')
    else bad('没落盘或值不对')

    out.push('\n=== 3. 拖工具栏：往左拖变宽 ===')
    const p0 = w('.rightpanel')
    await drag(hp, -70)
    const p1 = w('.rightpanel')
    out.push('  ' + p0 + ' → ' + p1 + '（拖 -70）')
    if (p1 > p0 + 30) ok('左拖变宽（方向与视觉一致）')
    else bad('方向反了或没变')
    if (Math.abs(store.getState().settings?.panelWidth - p1) <= 2) ok('panelWidth 已落盘')
    else bad('panelWidth 没落盘：' + store.getState().settings?.panelWidth)

    out.push('\n=== 4. 双击复原 ===')
    hr.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    /*
     * ⚠️ 轮询等宽度回到默认，不用固定 sleep。
     *    双击会做两件事：同步 removeProperty（CSS 变量）+ 异步落盘（IPC），
     *    而全量跑时主线程可能被前一个场景的收尾占着，
     *    固定 600ms 有时量到还没应用的状态（实测全量第 3 轮挂在这里）。
     */
    const backMs = await until(() => Math.abs(w('.rail') - 260) <= 3, 8000)
    const r2 = w('.rail')
    out.push('  复原后左栏 = ' + r2.toFixed(1) + '（设计默认 260，等了 ' + backMs + 'ms）')
    if (backMs >= 0) ok('双击回到设计默认宽度')
    else bad('没回到 260：' + r2)
    const resetPersisted = await until(() => store.getState().settings?.railWidth === 0, 8000)
    if (resetPersisted) ok('设置里回到 0（= 用默认，而不是把 260 写死）')
    else bad('railWidth=' + store.getState().settings?.railWidth)

    out.push('\n=== 5. 键盘：方向键微调 ===')
    hr.focus()
    const kb = (key, shift) => hr.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey: !!shift, bubbles: true, cancelable: true }))
    const k0 = w('.rail')
    kb('ArrowRight')
    await until(() => w('.rail') > k0 + 4, 4000)
    const k1 = w('.rail')
    kb('ArrowRight', true)
    await until(() => w('.rail') > k1 + 12, 4000)
    const k2 = w('.rail')
    out.push('  ' + k0.toFixed(1) + ' →(→) ' + k1.toFixed(1) + ' →(Shift+→) ' + k2.toFixed(1))
    if (k1 > k0 && k2 > k1) ok('方向键能调宽（Shift 步长更大）')
    else bad('键盘调整失效')
    kb('Home')
    const homeMs = await until(() => Math.abs(w('.rail') - 260) <= 3, 8000)
    if (homeMs >= 0) ok('Home 复原')
    else bad('Home 没复原：' + w('.rail').toFixed(1))

    out.push('\n=== 6. 拖动范围：下限 210、上限 420 ===')
    /*
     * 先验证超过下限但没有越过收起临界时，宽度和落盘值都精确夹到 210。
     */
    await drag(hr, -100)
    const min = w('.rail')
    const minStored = store.getState().settings?.railWidth
    out.push('  拖到下限后宽度=' + min + ' railWidth=' + minStored)
    if (Math.abs(min - 210) < 1) ok('下限精确夹到 210px')
    else bad('下限不正确：' + min)
    if (minStored === 210) ok('下限值已落盘')
    else bad('下限未落盘：' + minStored)

    await drag(hr, +9999)
    const wasPinned = store.getState().railPinned
    const big = store.getState().settings?.railWidth
    out.push('  极限右拖后 railWidth=' + big)
    if (big === 420 && Math.abs(w('.rail') - 420) < 1) ok('上限精确夹到 420px')
    else bad('没夹住：' + big)

    await drag(hr, -9999)
    // 收起是异步的一帧内落定，轮询等它
    const collapsed = await until(() => store.getState().railPinned === false, 4000)
    const slotAfter = w('.rail-slot')
    out.push('  极限左拖后 railPinned=' + store.getState().railPinned + '  列宽=' + slotAfter.toFixed(1) + '（之前 ' + wasPinned + '）')
    if (collapsed) ok('拖到过窄 → 直接收起（不是停在最小宽）')
    else bad('拖到过窄没收起，railPinned=' + store.getState().railPinned)
    /*
     * 收起保留 48px 的紧凑工具栏，并且必须有四个实际按钮。
     */
    const slotEl = document.querySelector('.rail-slot')
    const railEl = document.querySelector('.rail')
    const slotBg = slotEl ? getComputedStyle(slotEl).backgroundColor : '?'
    const railBg = railEl ? getComputedStyle(railEl).backgroundColor : '?'
    const railBorder = railEl ? getComputedStyle(railEl).borderRightWidth : '?'
    out.push('  收起槽: 宽=' + slotAfter.toFixed(1) + ' slot背景=' + slotBg + ' rail背景=' + railBg + ' rail右边框=' + railBorder)
    if (Math.abs(slotAfter - 48) < 1 && Math.abs(w('.rail') - 48) < 1) ok('收起后保留 48px 紧凑栏')
    else bad('收起宽度不正确：slot=' + slotAfter + ' rail=' + w('.rail'))
    const compactButtons = qa('.rail-compact > button')
    if (compactButtons.length === 4 && compactButtons.every((b) => b.getBoundingClientRect().width > 0)) ok('紧凑栏有四个可见按钮')
    else bad('紧凑栏按钮数量或尺寸不正确：' + compactButtons.length)

    // 展开回来（用标题栏的开关），并复位两个宽度，别把状态留给后面的场景
    store.getState().setRailPinned(true)
    await sleep(500)
    hr.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    hp.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await until(() => Math.abs(w('.rail') - 260) <= 3, 5000)
    await sleep(300)
  } catch (e) {
    bad('抛异常：' + (e && e.message ? e.message : String(e)))
  }
  out.push('')
  const failed = out.filter((l) => l.includes('✗')).length
  out.push(failed === 0 ? '[resize] 全部通过' : '[resize] ' + failed + ' 条失败')
  return out.join('\n')
})()
