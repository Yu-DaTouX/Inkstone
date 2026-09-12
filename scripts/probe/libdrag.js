/**
 * 从工具库拖拽到工具栏（用户要求：可拖拽 + 拖动时实时位置预览）。
 *
 * 「实时位置预览」在本项目里是**两个东西**，都要验：
 *   · 插入线（.rp-slot 的 data-over）—— 指出会插到哪个分区的前/后
 *   · 浮动标签（.tool-drag-ghost）—— 显示正在搬哪一块；
 *     拖到工具栏外时插入线消失，靠这个标签让用户知道「拖拽还在，Esc 可取消」
 *
 * 另外验了两条容易做错的行为：
 *   · 拖到工具栏**外**松手 = 取消（否则想放弃时分区会莫名跳位置）
 *   · 拖拽一开始就关掉库浮层（不关的话浮层盖住工具栏，看不见落点）
 *
 * ⚠️ 指针事件要同时派发到元素与 window —— 拖拽监听挂在 window 上
 *    （指针移出库行后元素收不到事件，这是跨组件拖拽的必然）。
 */
;(async () => {
  const out = []
  const ok = (m) => out.push('  ✓ ' + m)
  const bad = (m) => out.push('  ✗ ' + m)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const qa = (s) => [...document.querySelectorAll(s)]
  const until = async (fn, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(100) } return false }
  const store = window.__yanStore
  const ids = () => qa('.rp-body > .rp-slot').map((x) => x.dataset.toolId)
  /** 合成指针事件（window 上也发一份 —— 拖拽监听挂在 window 上） */
  const pe = (type, x, y, buttons) => {
    const ev = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 11, pointerType: 'mouse', isPrimary: true, button: 0, buttons, clientX: x, clientY: y })
    return ev
  }
  const fire = (target, ev) => { target.dispatchEvent(ev); window.dispatchEvent(ev) }

  try {
    localStorage.setItem('yan.onboarded', '1')
    for (let i = 0; i < 25; i++) { const c = document.querySelector('.ob-card'); if (!c) break
      const b = [...c.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent)); if (b) { click(b); await sleep(300) } else await sleep(150) }
    if (!store.getState().settings?.rightPanelOpen) await store.getState().toggleRightPanel()
    await store.getState().setToolLayout({ toolOrder: [], toolHidden: [] })
    await sleep(800)

    out.push('=== 1. 把「日志」收进库（准备从库里拖回来）===')
    // 先让它有内容，否则 isEmpty 不渲染
    store.setState({ logs: ['probe-line-1', 'probe-line-2'] })
    await sleep(400)
    if (!document.querySelector('[data-testid="tool-lib"]')) {
      click(document.querySelector('[data-testid="tool-lib-btn"]'))
      await until(() => document.querySelector('[data-testid="tool-lib"]'), 3000)
    }
    click(document.querySelector('[data-testid="tl-toggle-log"]'))
    await sleep(800)
    const afterHide = ids()
    out.push('  工具栏: ' + JSON.stringify(afterHide))
    if (!afterHide.includes('log')) ok('日志已收进库（不在工具栏里）')
    else bad('还在工具栏里')
    if (!document.querySelector('[data-testid="tool-lib"]')) {
      click(document.querySelector('[data-testid="tool-lib-btn"]'))
      await until(() => document.querySelector('[data-testid="tool-lib"]'), 3000)
    }

    out.push('\n=== 2. 从库里拖到工具栏（拖到「队列」之后）===')
    const row = document.querySelector('.tl-list [data-id="log"]')
    if (!row) bad('库里找不到 log 行')
    else {
      const rr = row.getBoundingClientRect()
      const queueSlot = qa('.rp-slot').find((x) => x.dataset.toolId === 'queue')
      const qr = queueSlot.getBoundingClientRect()
      const x0 = rr.x + rr.width - 20
      const y0 = rr.y + rr.height / 2

      fire(row, pe('pointerdown', x0, y0, 1))
      await sleep(150)
      const dragging = store.getState().draggingSection
      out.push('  draggingSection=' + dragging + '  浮层已关=' + !document.querySelector('[data-testid="tool-lib"]'))
      if (dragging === 'log') ok('进入拖拽状态') ; else bad('没进入拖拽状态')
      if (!document.querySelector('[data-testid="tool-lib"]')) ok('拖拽时自动关掉库浮层（否则挡住落点）')
      else bad('浮层没关，会挡住工具栏')

      // 拖到 queue 的下半部分
      const yDrop = qr.bottom - 6
      for (let i = 1; i <= 6; i++) fire(row, pe('pointermove', x0, y0 + ((yDrop - y0) * i) / 6, 1))
      await sleep(200)

      out.push('  实时预览：')
      const ghost = document.querySelector('[data-testid="tool-drag-ghost"]')
      out.push('    浮动标签 = ' + (ghost ? JSON.stringify(ghost.textContent) : '无'))
      if (ghost) ok('有跟着鼠标的浮动标签（显示正在搬哪一块）')
      else bad('没有浮动标签')
      const marked = qa('.rp-slot').filter((x) => x.dataset.over)
      out.push('    插入线标记 = ' + JSON.stringify(marked.map((x) => x.dataset.toolId + ':' + x.dataset.over)))
      if (marked.length === 1 && marked[0].dataset.toolId === 'queue' && marked[0].dataset.over === 'after') {
        ok('预览线实时指出「会插到 queue 之后」')
      } else bad('预览线不对：' + JSON.stringify(marked.map((x) => x.dataset.toolId + ':' + x.dataset.over)))

      fire(row, pe('pointerup', x0, yDrop, 0))
      await sleep(900)
      const after = ids()
      out.push('  拖后工具栏: ' + JSON.stringify(after))
      const li = after.indexOf('log'), qi = after.indexOf('queue')
      if (li === qi + 1) ok('松手后日志真的插到了 queue 之后')
      else bad('位置不对：log@' + li + ' queue@' + qi)
      if (!store.getState().settings?.toolHidden?.includes('log')) ok('从库拖进来后自动取消隐藏')
      else bad('还留在隐藏集合里')
      if (!store.getState().draggingSection) ok('拖拽状态已清空')
      else bad('拖拽状态没清')
      if (!document.querySelector('[data-testid="tool-drag-ghost"]')) ok('浮动标签已消失')
      else bad('浮动标签还在')
    }

    out.push('\n=== 3. Esc 取消 / 拖到工具栏外 = 不生效 ===')
    if (!document.querySelector('[data-testid="tool-lib"]')) {
      click(document.querySelector('[data-testid="tool-lib-btn"]'))
      await until(() => document.querySelector('[data-testid="tool-lib"]'), 3000)
    }
    const row2 = document.querySelector('.tl-list [data-id="log"]')
    if (row2) {
      const before = ids()
      const rr2 = row2.getBoundingClientRect()
      fire(row2, pe('pointerdown', rr2.x + rr2.width - 20, rr2.y + rr2.height / 2, 1))
      await sleep(120)
      // 拖到中栏（工具栏外）
      fire(row2, pe('pointermove', 400, 400, 1))
      await sleep(120)
      fire(row2, pe('pointerup', 400, 400, 0))
      await sleep(700)
      if (JSON.stringify(ids()) === JSON.stringify(before)) ok('拖到工具栏外松手 = 不改顺序（不会莫名跳位）')
      else bad('拖到外面也改了顺序：' + JSON.stringify(ids()))

      // Esc 取消
      if (!document.querySelector('[data-testid="tool-lib"]')) {
        click(document.querySelector('[data-testid="tool-lib-btn"]'))
        await until(() => document.querySelector('[data-testid="tool-lib"]'), 3000)
      }
      const row3 = document.querySelector('.tl-list [data-id="log"]')
      if (row3) {
        const r3 = row3.getBoundingClientRect()
        const before2 = ids()
        fire(row3, pe('pointerdown', r3.x + r3.width - 20, r3.y + r3.height / 2, 1))
        await sleep(150)
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        await sleep(400)
        if (!store.getState().draggingSection) ok('Esc 能取消拖拽')
        else bad('Esc 没取消')
        fire(row3, pe('pointerup', r3.x + r3.width - 20, r3.y + r3.height / 2, 0))
        await sleep(600)
        if (JSON.stringify(ids()) === JSON.stringify(before2)) ok('取消后顺序没变')
        else bad('取消后顺序变了')
      }
    }
    await store.getState().setToolLayout({ toolOrder: [], toolHidden: [] })
  } catch (e) { bad('抛异常：' + (e && e.message ? e.message : String(e))) }
  out.push('')
  const failed = out.filter((l) => l.includes('✗')).length
  out.push(failed === 0 ? '[libdrag] 全部通过' : '[libdrag] ' + failed + ' 条失败')
  return out.join('\n')
})()
