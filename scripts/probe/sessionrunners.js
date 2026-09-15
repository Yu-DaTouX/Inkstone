/**
 * 会话运行实例：前端身份过滤与左栏状态槽（N12）。
 *
 * 前端要解决的核心问题是「串线」：后台会话的事件（带 `runtime` 封套）
 * 绝不能写进当前正在看的会话。切回去时主进程会给完整快照，
 * 所以丢弃后台增量不会丢内容。
 *
 * 这里直接在 store 上驱动（不连 pi、不起第二个进程）：
 *   · 注入带不同 runtime 封套的推送，断言只进对应的视图；
 *   · 注入 runners 快照，断言左栏每一行显示自己的运行/失败状态；
 *   · 断言会话菜单里有「停止运行」（单独停一个实例）。
 */
;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const store = window.__yanStore
  const until = async (fn, ms = 5000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (fn()) return true
      await sleep(80)
    }
    return false
  }

  try {
    for (let i = 0; i < 60; i++) {
      if (q('.rail') && store.getState().settings) break
      await sleep(250)
    }
    localStorage.setItem('yan.onboarded', '1')
    store.getState().setRailPinned(true)
    store.setState({ refreshSessions: async () => {} })
    await sleep(300)

    const cwd = store.getState().settings.cwd
    const stamp = Date.now()
    const mk = (id, title) => ({
      id, title, path: `${cwd}/${id}.jsonl`, cwd,
      createdAt: stamp, updatedAt: stamp, lastActivityAt: stamp, messageCount: 1
    })
    const a = mk('n12-a', 'N12 当前会话')
    const b = mk('n12-b', 'N12 后台会话')
    store.setState({
      sessions: [a, b],
      messages: [],
      activeRunnerId: 'r1',
      session: { ...(store.getState().session ?? {}), sessionId: a.id, sessionFile: a.path, cwd, isAgentRunning: false }
    })
    await sleep(500)
    ok(qa('[data-session-path]').length === 2, '两个会话行都渲染出来了')

    /* ---- 1. 身份过滤：别的实例的事件不得进当前视图 ---- */
    out.push('')
    out.push('=== 1. 身份过滤（后台会话的输出不串进当前视图）===')
    const before = store.getState().messages.length
    const runtimeA = { sessionId: a.id, runId: 'r1', projectId: 'project-a', generation: 1 }
    const runtimeB = { sessionId: b.id, runId: 'r2', projectId: 'project-a', generation: 1 }
    store.getState().applyPush({
      ch: 'msg-add',
      runtime: runtimeB,
      payload: { id: 'bg-1', role: 'assistant', text: '我是后台会话的输出' }
    })
    await sleep(200)
    ok(
      store.getState().messages.length === before,
      `后台实例(r2)的 msg-add 被丢弃（当前 ${store.getState().messages.length} 条，原 ${before}）`
    )
    ok(!q('.stream')?.textContent?.includes('我是后台会话的输出'), '后台内容没有出现在对话区')

    store.getState().applyPush({
      ch: 'msg-add',
      runtime: runtimeA,
      payload: { id: 'fg-1', role: 'assistant', text: '我是当前会话的输出' }
    })
    await sleep(300)
    ok(store.getState().messages.length === before + 1, '当前实例(r1)的事件正常进视图')
    ok(!!q('.stream')?.textContent?.includes('我是当前会话的输出'), '当前内容出现在对话区')

    /* 带 key 的 state 推送同样要过滤 */
    store.getState().applyPush({
      ch: 'state',
      runtime: runtimeB,
      payload: { ...store.getState().session, sessionId: b.id, sessionFile: b.path, isAgentRunning: true }
    })
    await sleep(200)
    ok(store.getState().session?.sessionFile === a.path, '后台实例的 state 不会改掉当前会话状态')

    /* 全局推送不受影响 */
    store.getState().applyPush({ ch: 'runners', payload: [] })
    ok(Array.isArray(store.getState().runners), '不带 key 的全局推送（runners）照常生效')

    /* ---- 2. 左栏状态槽来自 runners 快照 ---- */
    out.push('')
    out.push('=== 2. 每行会话显示自己的运行状态 ===')
    const status = (id, sessionFile, extra) => ({
      id, runId: id, generation: 1, sessionFile, sessionId: sessionFile, cwd,
      running: false, waiting: false, failed: false, conn: 'ready',
      createdAt: stamp, lastActiveAt: stamp, isActive: id === 'r1',
      ...extra
    })
    store.getState().applyPush({
      ch: 'runners',
      payload: [status('r1', a.path), status('r2', b.path, { running: true })]
    })
    await sleep(400)
    const rowOf = (path) => qa('[data-session-path]').find((e) => e.dataset.sessionPath === path)
    const rowA = rowOf(a.path)
    const rowB = rowOf(b.path)
    out.push('  A 行状态 = ' + JSON.stringify(rowA?.querySelector('.session-status')?.className ?? null))
    out.push('  B 行状态 = ' + JSON.stringify(rowB?.querySelector('.session-status')?.className ?? null))
    ok(!!rowB?.querySelector('.session-status.running'), '**后台**会话行显示「运行中」（这正是以前看不到的）')
    ok(!rowA?.querySelector('.session-status.running'), '没在跑的会话行不显示运行状态')

    /* 等待输入 / 失败 */
    store.getState().applyPush({
      ch: 'runners',
      payload: [status('r1', a.path, { waiting: true }), status('r2', b.path, { failed: true })]
    })
    await sleep(400)
    const rowA2 = rowOf(a.path)
    const rowB2 = rowOf(b.path)
    out.push('  A 行(等待) = ' + JSON.stringify(rowA2?.querySelector('.session-status')?.textContent ?? null))
    out.push('  B 行(失败) = ' + JSON.stringify(rowB2?.querySelector('.session-status')?.className ?? null))
    ok(!!rowA2?.querySelector('.session-status.waiting'), '等待输入的会话行有状态标记')
    ok(!!rowB2?.querySelector('.session-status'), '失败的会话行有状态标记')

    /* ---- 3. 会话菜单里能单独停掉一个实例 ---- */
    out.push('')
    out.push('=== 3. 单独停止一个运行实例 ===')
    store.getState().applyPush({
      ch: 'runners',
      payload: [status('r1', a.path), status('r2', b.path, { running: true })]
    })
    await sleep(400)
    const acts = rowOf(b.path)?.querySelector('.srow-acts button')
    ok(!!acts, '后台会话行有动作按钮')
    if (acts) click(acts)
    await sleep(350)
    const stopBtn = q('[data-testid="rail-stop-runner"]')
    ok(!!stopBtn, '菜单里有「停止运行」（后台会话可以单独停）')
    out.push('  菜单项 = ' + JSON.stringify((stopBtn?.textContent || '').trim()))
    const menuPath = q('.srow-menu-path')?.textContent ?? ''
    ok(menuPath.includes(b.id), '打开的是那一行的菜单（不是当前会话的）')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await sleep(200)

    /* 收尾：清掉探针注入的状态 */
    store.setState({ runners: [], activeRunnerId: null })
    await sleep(200)
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
