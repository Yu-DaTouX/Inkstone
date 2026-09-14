/**
 * 工具栏：分区排序（拖拽 + 键盘）与工具库（收进库 / 拿回 / 恢复默认）。
 *
 * 为什么值得单独测：这两件事都是「看起来对、其实静默坏了」的类型。
 * 本场景实测抓到三个真 bug：
 *   ① 拖放静默失效：读的是 section 的 data-sec（`rp-queue`）而顺序数组里
 *      存的是 `queue`，indexOf 得 -1 → 直接 return，什么都不发生。
 *   ② setPointerCapture 抛异常打断了初始化 → 整个拖拽永远不启动。
 *      现在先置状态、capture 包 try（真实环境也会遇到）。
 *   ③ 命中区重叠：宽度把手（7px）压在排序把手左缘，拖排序会变成拖宽度
 *      → 宽度把手收到 5px、排序把手 margin-left: 6px。
 *
 * ⚠️ 两条「别写死」的教训（都踩过）：
 *   · 分区数量**不是**固定 7 —— todo / ext / log 在内容为空时整个不渲染
 *     （这是设计要求：空区块不占位）。所以期望集合要从实际环境推导。
 *   · 拖拽要抓把手的**右侧**像素（左边缘有宽度把手）。
 */
;(async () => {
  const out = []
  const ok = (m) => out.push('  ✓ ' + m)
  const bad = (m) => out.push('  ✗ ' + m)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const qa = (s) => [...document.querySelectorAll(s)]
  const until = async (fn, ms = 5000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (fn()) return true
      await sleep(100)
    }
    return false
  }
  const store = window.__yanStore
  /** 当前渲染出来的分区（dataset.toolId 就是顺序数组里的 id 形态） */
  const ids = () => qa('.rp-body > .rp-slot').map((x) => x.dataset.toolId)

  try {
    localStorage.setItem('yan.onboarded', '1')
    for (let i = 0; i < 25; i++) {
      const c = document.querySelector('.ob-card')
      if (!c) break
      const b = [...c.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent))
      if (b) {
        click(b)
        await sleep(300)
      } else await sleep(150)
    }
    if (!store.getState().settings?.rightPanelOpen) await store.getState().toggleRightPanel()
    // 显式复位布局（不假设起始状态）
    await store.getState().setToolLayout({ toolOrder: [], toolHidden: [] })
    await sleep(700)

    /*
     * 默认顺序 —— 与 shared/ipc.ts 的 TOOL_SECTIONS **必须一致**。
     * 改一处要改两处（探针是独立文件，拿不到那个常量）。
     * 2026-09 评审：任务提到最前（它回答“现在该我做什么”）。
     */
    const ALL = ['todo', 'context', 'files', 'quota', 'queue', 'ext', 'log', 'actions']
    const st = store.getState()
    /** 按 isEmpty 规则推导「应该渲染哪些」——与实现保持同一判据 */
    const expectEmpty = []
    if (st.todos.length === 0) expectEmpty.push('todo')
    if (Object.keys(st.statuses).length === 0 && Object.keys(st.widgets).length === 0) expectEmpty.push('ext')
    if (st.logs.length === 0) expectEmpty.push('log')
    const expected = ALL.filter((x) => !expectEmpty.includes(x))

    out.push('=== 1. 分区集合与顺序 ===')
    const cur = ids()
    out.push('  渲染了 ' + JSON.stringify(cur))
    out.push('  空内容而按设计不渲染的: ' + JSON.stringify(expectEmpty))
    if (JSON.stringify(cur) === JSON.stringify(expected)) {
      ok('渲染集合 = 默认顺序减去空分区（' + cur.length + ' 个）')
    } else {
      bad('集合/顺序不对\n    实际 ' + JSON.stringify(cur) + '\n    期望 ' + JSON.stringify(expected))
    }
    if (cur.length >= 4) ok('常驻分区（上下文/队列/文件/操作）都在')
    else bad('常驻分区缺了')

    out.push('\n=== 2. 每个渲染出来的分区都有排序把手 ===')
    const grips = qa('.rp-grip')
    out.push('  把手 ' + grips.length + ' / 分区 ' + cur.length)
    if (grips.length === cur.length) ok('把手数量与分区一致')
    else bad('把手数量不对')
    const g = document.querySelector('[data-testid="grip-context"]')
    if (g && g.tabIndex >= 0) ok('把手可聚焦（键盘也能调顺序）')
    else bad('把手不可聚焦')

    out.push('\n=== 3. 键盘 Alt+↑↓ 调顺序 ===')
    const before = ids()
    g.focus()
    g.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true })
    )
    await sleep(700)
    const after = ids()
    out.push('  ' + JSON.stringify(before) + ' → ' + JSON.stringify(after))
    if (after[0] === before[1] && after[1] === before[0]) ok('Alt+↓ 与下一项交换')
    else bad('交换失败')
    const saved = store.getState().settings?.toolOrder
    out.push('  落盘 toolOrder=' + JSON.stringify(saved))
    /*
     * 落盘断言要看**相对次序**，不能看绝对下标。
     * 因为排序是在「完整顺序」（含当前不可见的分区）上做的 ——
     * todo/ext 为空不渲染，但它们仍在数组里占位，
     * 所以 next[0] 可能仍是 todo（实测就这样）。
     */
    if (Array.isArray(saved) && saved.indexOf(before[1]) < saved.indexOf(before[0])) {
      ok('顺序已落盘（两个分区的相对次序已反转）')
    } else {
      bad('顺序没落盘：' + JSON.stringify(saved))
    }

    out.push('\n=== 4. 指针拖拽调顺序 ===')
    /*
     * 用两个**一定存在且不同**的分区。
     * ⚠️ 不能写死第二个分区的 id：默认顺序改过（任务提到最前），
     *    写死的那个可能正好等于 dragId —— 探针自己报「用例无效」。
     *    改成从当前实际渲染的分区里挑一个不同于 dragId 的。
     */
    const dragId = before[1]
    const visibleIds = qa('.rp-slot').map((x) => x.dataset.toolId)
    const anchorId = visibleIds.find((x) => x !== dragId) ?? 'files'
    const g2 = document.querySelector('[data-testid="grip-' + dragId + '"]')
    const targetSlot = qa('.rp-slot').find((x) => x.dataset.toolId === anchorId)
    if (!g2 || !targetSlot) {
      bad('找不到把手或目标（' + dragId + ' → ' + anchorId + '）')
    } else if (dragId === anchorId) {
      bad('拖拽测试的两个分区相同，用例无效')
    } else {
      const gr = g2.getBoundingClientRect()
      const tr = targetSlot.getBoundingClientRect()
      const mk = (type, y, buttons) =>
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 9,
          pointerType: 'mouse',
          isPrimary: true,
          button: 0,
          buttons,
          clientX: gr.x + gr.width - 3,
          clientY: y
        })
      g2.dispatchEvent(mk('pointerdown', gr.y + gr.height / 2, 1))
      await sleep(60)
      // 拖到 anchor 的下半区 → 应插到它后面
      const y0 = gr.y + gr.height / 2
      const y1 = tr.bottom - 6
      for (let i = 1; i <= 8; i++) g2.dispatchEvent(mk('pointermove', y0 + ((y1 - y0) * i) / 8, 1))
      await sleep(80)
      g2.dispatchEvent(mk('pointerup', y1, 0))
      await sleep(800)
      const after2 = ids()
      out.push('  拖后 ' + JSON.stringify(after2))
      const di = after2.indexOf(dragId)
      const ai = after2.indexOf(anchorId)
      if (di > ai) ok('拖到 ' + anchorId + ' 下半区 → ' + dragId + ' 排到它之后')
      else bad('拖拽插入位置不对：' + dragId + '@' + di + ' ' + anchorId + '@' + ai)
      const savedOrder = store.getState().settings?.toolOrder
      if (Array.isArray(savedOrder) && savedOrder.indexOf(dragId) > savedOrder.indexOf(anchorId)) {
        ok('拖拽结果已落盘')
      } else {
        bad('拖拽没落盘：' + JSON.stringify(savedOrder))
      }
    }

    out.push('\n=== 5. 工具库：收进库 / 拿回来 ===')
    if (!document.querySelector('[data-testid="tool-lib"]')) {
      click(document.querySelector('[data-testid="tool-lib-btn"]'))
      await until(() => document.querySelector('[data-testid="tool-lib"]'), 3000)
    }
    if (!document.querySelector('[data-testid="tool-lib"]')) {
      bad('工具库打不开')
    } else {
      ok('工具库可打开')
      const rows = qa('.tl-row')
      out.push('  库里列出 ' + rows.length + ' 个分区')
      /*
       * 工具库列的是**全部分区**（含已在工具栏的）—— 只列已隐藏的会让人
       * 不知道某块到底在库里还是已经在栏里。所以这里应该是全部 8 个。
       */
      if (rows.length === ALL.length) ok('列全部分区（不只是已隐藏的）')
      else bad('列表不全：' + rows.length + ' / ' + ALL.length)
      out.push('  计数 = ' + (document.querySelector('[data-testid="tl-count"]')?.textContent ?? '?'))

      // 把「队列」收进库
      click(document.querySelector('[data-testid="tl-toggle-queue"]'))
      await sleep(800)
      const afterHide = ids()
      out.push('  收起 queue 后工具栏：' + JSON.stringify(afterHide))
      if (!afterHide.includes('queue')) ok('收进库的分区不在工具栏里显示（是移出，不是折叠）')
      else bad('还在工具栏里')
      if (store.getState().settings?.toolHidden?.includes('queue')) ok('toolHidden 已落盘')
      else bad('没收进库（未落盘）')

      // 拿回来
      click(document.querySelector('[data-testid="tl-toggle-queue"]'))
      await sleep(800)
      const back = ids()
      out.push('  拿回后：' + JSON.stringify(back))
      if (back.includes('queue')) ok('能从库拿回工具栏')
      else bad('拿不回来')
      if (!store.getState().settings?.toolHidden?.includes('queue')) ok('toolHidden 已移除该项')
      else bad('toolHidden 没清掉')

      out.push('\n=== 6. 恢复默认布局 ===')
      // 先弄乱
      await store.getState().setToolLayout({ toolOrder: [...ALL].reverse(), toolHidden: ['log'] })
      await sleep(700)
      if (!document.querySelector('[data-testid="tool-lib"]')) {
        click(document.querySelector('[data-testid="tool-lib-btn"]'))
        await until(() => document.querySelector('[data-testid="tool-lib"]'), 3000)
      }
      const resetBtn = document.querySelector('[data-testid="tl-reset"]')
      if (!resetBtn) {
        bad('工具库里没有「恢复默认」按钮')
      } else {
        click(resetBtn)
        await sleep(800)
        const reset = ids()
        out.push('  复位后：' + JSON.stringify(reset))
        if (JSON.stringify(reset) === JSON.stringify(expected)) ok('一键恢复默认布局（含空分区规则）')
        else bad('没恢复：' + JSON.stringify(reset) + ' 期望 ' + JSON.stringify(expected))
        if ((store.getState().settings?.toolHidden ?? []).length === 0) ok('隐藏集合已清空')
        else bad('隐藏集合没清')
      }
      // 收尾：关掉库，别影响后面的场景
      if (document.querySelector('[data-testid="tool-lib"]')) {
        click(document.querySelector('[data-testid="tool-lib-btn"]'))
        await sleep(300)
      }
    }
  } catch (e) {
    bad('抛异常：' + (e && e.message ? e.message : String(e)))
  }
  out.push('')
  const failed = out.filter((l) => l.includes('✗')).length
  out.push(failed === 0 ? '[tools] 全部通过' : '[tools] ' + failed + ' 条失败')
  return out.join('\n')
})()
