;(async () => {
  const out = []
  const ok = (c, s, extra = '') => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s + (extra ? '  ' + extra : ''))
    return !!c
  }
  const note = (s) => out.push('  · ' + s)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const until = async (fn, timeout = 4000) => {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      try {
        if (fn()) return true
      } catch {}
      await sleep(50)
    }
    return false
  }
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const store = window.__yanStore
  const composer = window.__yanComposer

  const pending = () => store.getState().pendingSends ?? []
  const pendingRows = () => qa('[data-testid="queue-pending"]')
  const openMenus = () => qa('.cq-menu')
  const menuItems = (testIds = false) => {
    const menu = openMenus()[openMenus().length - 1]
    if (!menu) return []
    const items = [...menu.querySelectorAll('[role="menuitem"]')]
    return testIds ? items.map((el) => el.dataset.testid ?? '?') : items
  }
  const openPendingMenu = async () => {
    const opened = openMenus()
    opened[opened.length - 1]?.querySelector('[role="menuitem"]')?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    )
    await until(() => openMenus().length === 0, 3000)
    const before = openMenus().length
    q('[data-testid="pending-actions"]')?.click()
    await until(() => openMenus().length === before + 1, 3000)
    await sleep(150)
    return menuItems(true)
  }
  const clickMenuItem = (testId) => {
    const menu = openMenus().find((el) => el.querySelector(`[data-testid="${testId}"]`))
    menu?.querySelector(`[data-testid="${testId}"]`)?.click()
  }

  const runner = (running, streaming) => ({
    id: 'probe-run-1',
    runId: 'probe-run-1',
    sessionFile: 'probe-pending.jsonl',
    sessionId: 'probe-pending',
    projectId: undefined,
    generation: 1,
    cwd: 'C:/yan-probe',
    running,
    waiting: false,
    failed: false,
    conn: 'ready',
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    isActive: true,
    isStreaming: streaming
  })

  const sent = []
  let sendOk = true

  try {
    localStorage.setItem('yan.onboarded', '1')
    for (let i = 0; i < 40; i++) {
      if (q('[data-testid="composer-input"]') && store?.getState().settings) break
      await sleep(250)
    }
    if (!store || !composer) {
      out.push('  ⤺ 跳过：没有 window.__yanStore / window.__yanComposer（探针没被注入）')
      return out.join('\n')
    }
    await sleep(400)

    const input = q('[data-testid="composer-input"]')
    if (!input) {
      out.push('  ⤺ 跳过：输入框还没挂载')
      return out.join('\n')
    }
    input.id = 'probe-composer'
    const editor = () => q('#probe-composer')
    const type = async (text) => {
      composer.set(text, editor())
      await sleep(150)
    }
    const pressEnter = (init = {}) => {
      const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init })
      editor().dispatchEvent(ev)
      return ev.defaultPrevented
    }
    const pressCtrlQ = () => {
      const ev = new KeyboardEvent('keydown', { key: 'q', ctrlKey: true, bubbles: true, cancelable: true })
      editor().dispatchEvent(ev)
      return ev.defaultPrevented
    }
    const idle = () => store.setState({ activeRunnerId: null, runners: [] })
    const busy = () => store.setState({ activeRunnerId: 'probe-run-1', runners: [runner(true, true)] })
    const setCompacting = (value) => {
      const session = store.getState().session
      if (!session) return false
      store.setState({ session: { ...session, isCompacting: value } })
      return true
    }

    store.setState({
      send: async (text, images, mode) => {
        sent.push({ text, mode, images: images?.length ?? 0 })
        return sendOk
      }
    })

    out.push('=== 1. 回合没跑：Enter 直接发送（不经过待定区） ===')
    idle()
    await sleep(150)
    await type('YAN-PENDING-DIRECT')
    pressEnter()
    await sleep(300)
    note(`投递记录 = ${JSON.stringify(sent)}`)
    ok(sent.length === 1 && sent[0].text === 'YAN-PENDING-DIRECT', '空闲时 Enter 直接投出去')
    ok(sent[0]?.mode === undefined, '空闲投递不带 mode（渲染端不指定 streamingBehavior）')
    ok(pending().length === 0 && pendingRows().length === 0, '空闲时不进待定区')
    ok(await until(() => composer.text(editor()) === ''), '投出去后输入框清空')

    out.push('')
    out.push('=== 2. 回合在跑：Enter 插话，Alt+Enter / Ctrl+Q 排队 ===')
    sent.length = 0
    busy()
    await sleep(200)
    await type('YAN-PENDING-STEER')
    const steerPrevented = pressEnter()
    await sleep(300)
    note(`Enter 投递 = ${JSON.stringify(sent)}`)
    ok(steerPrevented && sent.length === 1 && sent[0].mode === 'steer', '运行时 Enter 以 steer 插话')
    ok(pending().length === 0 && pendingRows().length === 0, '插话不生成待定卡片')
    ok(await until(() => composer.text(editor()) === ''), '输入框清空，可继续输入')

    sent.length = 0
    await type('YAN-PENDING-QUEUE')
    const altPrevented = pressEnter({ altKey: true })
    await sleep(300)
    note(`Alt+Enter 投递 = ${JSON.stringify(sent)}`)
    ok(altPrevented && sent.length === 1 && sent[0].mode === 'followUp', '运行时 Alt+Enter 以 followUp 排队')
    ok(pending().length === 0, '排队不生成待定卡片')

    sent.length = 0
    await type('YAN-PENDING-CTRLQ')
    const ctrlQPrevented = pressCtrlQ()
    await sleep(300)
    note(`Ctrl+Q 投递 = ${JSON.stringify(sent)}`)
    ok(ctrlQPrevented && sent.length === 1 && sent[0].mode === 'followUp', '运行时 Ctrl+Q 以 followUp 排队')

    out.push('')
    out.push('=== 3. 压缩期间：仍以 followUp 投递，不进待定区 ===')
    sent.length = 0
    idle()
    await sleep(150)
    const hasSession = setCompacting(true)
    if (!hasSession) {
      out.push('  ⤺ 跳过：本场景没有活动会话，摆不出压缩态')
    } else {
      await sleep(200)
      ok(store.getState().session?.isCompacting === true, '前提：session.isCompacting = true')
      ok(!store.getState().runners.some((r) => (r.runId ?? r.id) === store.getState().activeRunnerId && r.running), '前提：回合本身没在跑')
      await type('YAN-PENDING-COMPACT')
      pressEnter()
      await sleep(300)
      note(`压缩期投递 = ${JSON.stringify(sent)} · 待定 = ${pending().length}`)
      ok(sent.length === 1 && sent[0].mode === 'followUp', '压缩期间 Enter 以 followUp 投递（主进程按 isCompacting 加 streamingBehavior）')
      ok(pending().length === 0, '压缩期间不再写入待定区')
      setCompacting(false)
      await sleep(200)
    }

    out.push('')
    out.push('=== 4. 待定区：行、标签与行菜单 ===')
    sent.length = 0
    idle()
    await sleep(150)
    store.getState().holdSend('YAN-PENDING-HOLD')
    ok(await until(() => pendingRows().length === 1), '待定消息渲染成一行')
    const row = pendingRows()[0]
    ok((row?.textContent ?? '').includes('YAN-PENDING-HOLD'), '行里显示待投递文本')
    const pillText = row?.querySelector('.cq-pill')?.textContent ?? ''
    ok(/^(排队|Queued) · 1$/.test(pillText), '单条行首是「排队 · 1」胶囊', JSON.stringify(pillText))
    ok(!/下一条|Next:/.test(row?.textContent ?? ''), '单条时不带「下一条」前缀')
    ok(!!q('[data-testid="queue-toggle"]') === false, '只有一条时不折叠成计数条')
    ok(!q('[data-testid="queue-clear-all"]'), '只有一条时不另起「全部清除」行，删除收在行菜单里')
    const idleMenu = await openPendingMenu()
    note(`空闲时行菜单 = ${JSON.stringify(idleMenu)}`)
    ok(idleMenu.includes('pending-follow') && idleMenu.includes('pending-restore'), '行菜单有「发送」与「撤回」')
    ok(idleMenu.includes('pending-discard'), '行菜单有「删除」（直接丢弃，不回填草稿）')
    ok(!idleMenu.includes('pending-steer'), '回合没跑时没有「插话」项')

    out.push('')
    out.push('=== 5. 「发送」投递并清行 ===')
    sent.length = 0
    clickMenuItem('pending-follow')
    ok(await until(() => sent.length === 1), '点「发送」投递一次', `投递记录 = ${JSON.stringify(sent)}`)
    ok(sent[0]?.text === 'YAN-PENDING-HOLD', '投递的是这条待定消息')
    ok(await until(() => pending().length === 0 && pendingRows().length === 0), '投完行消失')

    out.push('')
    out.push('=== 6. 「撤回」不投递，文字回到输入框 ===')
    sent.length = 0
    store.getState().holdSend('YAN-PENDING-RESTORE')
    await until(() => pendingRows().length === 1)
    const restoreMenu = await openPendingMenu()
    ok(restoreMenu.includes('pending-restore'), '行菜单里有「撤回」')
    clickMenuItem('pending-restore')
    ok(await until(() => composer.text(editor()).includes('YAN-PENDING-RESTORE')), '文字回到输入草稿', JSON.stringify(composer.text(editor())))
    ok(sent.length === 0, '撤回**不**投递')
    ok(await until(() => pending().length === 0 && pendingRows().length === 0), '行消失')
    composer.set('', editor())
    await sleep(150)

    out.push('')
    out.push('=== 7. 回合在跑时的待定项：插话 / 排队 ===')
    sent.length = 0
    store.getState().holdSend('YAN-PENDING-RUNNING')
    busy()
    await until(() => pendingRows().length === 1)
    const runningMenu = await openPendingMenu()
    note(`运行中行菜单 = ${JSON.stringify(runningMenu)}`)
    ok(runningMenu.includes('pending-steer'), '回合在跑时多出「插话」项')
    clickMenuItem('pending-steer')
    ok(await until(() => sent.length === 1), '点「插话」投递一次', `投递记录 = ${JSON.stringify(sent)}`)
    ok(sent[0]?.mode === 'steer', '插话以 steer 投递')
    ok(await until(() => pending().length === 0 && pendingRows().length === 0), '投完行消失')

    out.push('')
    out.push('=== 8. 投递失败：行留在原地，不假装成功 ===')
    sent.length = 0
    sendOk = false
    store.getState().holdSend('YAN-PENDING-FAIL')
    await until(() => pendingRows().length === 1)
    await openPendingMenu()
    clickMenuItem('pending-follow')
    await sleep(400)
    note(`投递尝试 = ${JSON.stringify(sent)} · 剩余待定 = ${pending().length}`)
    ok(sent.length === 1, '确实尝试过投递')
    ok(pending().length === 1 && pendingRows().length === 1, '失败时行**留在原地**（用户能重试或撤回，而不是默默丢消息）')
    const retryMenu = await openPendingMenu()
    ok(retryMenu.includes('pending-follow'), '行菜单还在，可以再试一次')

    out.push('')
    out.push('=== 9. 收尾：清掉探针造的状态 ===')
    sendOk = true
    for (const item of [...pending()]) store.getState().restoreSend(item.id)
    composer.set('', editor())
    await sleep(150)
    sent.length = 0
    store.getState().holdSend('YAN-PENDING-CLEAR')
    await until(() => pendingRows().length === 1)
    await openPendingMenu()
    clickMenuItem('pending-discard')
    ok(await until(() => pending().length === 0 && pendingRows().length === 0), '行菜单「删除」直接丢弃待定条目')
    await sleep(200)
    ok(!composer.text(editor()).includes('YAN-PENDING-CLEAR'), '删除不把文字放回输入框', JSON.stringify(composer.text(editor())))
    ok(sent.length === 0, '删除不投递')
    for (const item of [...pending()]) store.getState().restoreSend(item.id)
    ok(await until(() => pending().length === 0 && pendingRows().length === 0), '待定区清空')
    composer.set('', editor())
    idle()
    await sleep(200)
  } catch (error) {
    out.push('  ✗ 探针异常：' + (error?.stack ?? String(error)))
  }

  try {
    sendOk = true
    for (const item of [...pending()]) store.getState().restoreSend(item.id)
    store.setState({ activeRunnerId: null, runners: [] })
  } catch {}
  return out.join('\n')
})()
