/*
 * 分屏探针（视觉矩阵 `YAN_MATRIX_ONLY=splitview,splitfocus`，全部为合成数据）。
 *
 * 在当前会话旁边放一条合成的后台会话（运行中），检查：
 *   · 焦点一侧有完整输入框，另一侧只读、输入框收成一行；
 *   · `__FOCUS__` = chat：焦点在主会话位；= peer：焦点在旁边那一侧（两侧位置不交换）；
 *   · 当前会话里放一条 Codemode 调用，子调用嵌在父调用之下。
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const store = window.__yanStore
  const split = window.__yanSplit
  const st = store.getState()
  st.closeSettings?.()
  const now = Date.now()
  const live = st.session
  const liveRef = { sessionId: live?.sessionId || undefined, path: live?.sessionFile || undefined }
  if (!liveRef.sessionId && !liveRef.path) throw new Error('splitview: 没有当前会话')
  const peerId = 'split-peer-fixture'
  const peerRef = { sessionId: peerId, path: 'C:/fixture/split-peer.jsonl' }
  const peerMessages = [
    { id: 'sp-u1', role: 'user', text: '把登录页的按钮改成主题强调色，深浅主题都看一下。', timestamp: now - 90_000 },
    { id: 'sp-a1', role: 'assistant', text: '先找按钮样式的定义位置。', timestamp: now - 80_000, toolCalls: [
      { id: 'sp-t1', name: 'grep', args: { pattern: 'login-submit' }, status: 'ok', output: 'src/pages/login.css:42' },
      { id: 'sp-t2', name: 'read', args: { path: 'src/pages/login.css' }, status: 'ok', output: '.login-submit { background: #3b82f6 }' }
    ] },
    { id: 'sp-a2', role: 'assistant', text: '正在把硬编码的颜色换成 `--accent` 令牌。', timestamp: now - 10_000, toolCalls: [
      { id: 'sp-t3', name: 'edit', args: { path: 'src/pages/login.css', edits: [{ oldText: 'background: #3b82f6', newText: 'background: var(--accent)' }] }, status: 'running', startedAt: now - 3_000 }
    ] }
  ]
  store.setState({
    sessions: [...st.sessions.filter((s) => s.id !== peerId), { ...(st.sessions[0] ?? {}), id: peerId, path: peerRef.path, title: '登录页按钮改用主题色', updatedAt: now, lastActivityAt: now }],
    sessionRuntimes: {
      ...st.sessionRuntimes,
      [peerId]: {
        runtime: { runId: 'split-peer-run', sessionId: peerId, generation: 1 },
        session: { ...(live ?? {}), sessionId: peerId, sessionFile: peerRef.path, isAgentRunning: true, isStreaming: false },
        messages: peerMessages,
        uiRequests: [],
        queue: { steering: [], followUp: [] }
      }
    },
    messages: [
      { id: 'sv-u1', role: 'user', text: '并行读一下状态板和决定日志，整理还没做完的事。', timestamp: now - 60_000 },
      { id: 'sv-a1', role: 'assistant', text: '两份都读完了：分屏和会话移动还在进行中，其余已交付。', timestamp: now - 50_000, toolCalls: [
        { id: 'code', name: 'codemode', args: { code: 'const files = [".local-docs/STATUS.md", ".local-docs/DECISIONS.md"]\nfor (const path of files) text(await tools.read({ path }))' }, status: 'ok', output: 'Script completed', startedAt: now - 58_000, endedAt: now - 56_000 },
        { id: 'code/1', parentToolCallId: 'code', name: 'read', args: { path: '.local-docs/STATUS.md' }, status: 'ok', historySummary: true },
        { id: 'code/2', parentToolCallId: 'code', name: 'read', args: { path: '.local-docs/DECISIONS.md' }, status: 'ok', historySummary: true },
        { id: 'code/3', parentToolCallId: 'code', name: 'bash', args: { command: 'git status --short' }, status: 'error', output: 'fatal: not a git repository', historySummary: true }
      ] }
    ]
  })
  if ('__FOCUS__' === 'peer') {
    /* 焦点在旁边那一侧：当前会话绑在 peer 位，合成会话在主会话位 */
    split.setState({ split: { tiles: [peerRef, liveRef], live: 1 } })
  } else {
    split.getState().close()
    split.getState().open(peerRef, liveRef)
  }
  await sleep(700)
  const focusPane = '__FOCUS__' === 'peer' ? 'chat-peer' : 'chat'
  const idlePane = '__FOCUS__' === 'peer' ? 'chat' : 'chat-peer'
  if (!document.querySelector(`[data-workspace-pane="${focusPane}"] [data-testid="split-live"] .composer-wrap`)) throw new Error('splitview: 焦点一侧没有输入框')
  if (!document.querySelector(`[data-workspace-pane="${idlePane}"] [data-testid="split-peer"] [data-testid="split-peer-focus"]`)) throw new Error('splitview: 非焦点一侧没有收起的输入行')
  if (document.querySelector(`[data-workspace-pane="${idlePane}"] .composer-wrap`)) throw new Error('splitview: 非焦点一侧不该有完整输入框')
  const nest = document.querySelector(`[data-workspace-pane="${focusPane}"] [data-testid="tool-nest"]`)
  if (!nest || nest.querySelectorAll('[data-testid="tool-row"]').length !== 3) throw new Error('splitview: Codemode 子调用没有嵌在父调用之下')
  const a = document.querySelector('[data-workspace-pane="chat"]').getBoundingClientRect()
  const b = document.querySelector('[data-workspace-pane="chat-peer"]').getBoundingClientRect()
  const box = (r) => `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`
  if (!(a.right <= b.left + 1) || a.width < 200 || b.width < 200) throw new Error(`splitview: 两侧没有左右并排 chat=${box(a)} peer=${box(b)}`)
  return `ok(focus=${focusPane} widths=${Math.round(a.width)}/${Math.round(b.width)})`
})()
