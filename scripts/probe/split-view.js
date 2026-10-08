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
  /* 分屏时每条会话一列（会话 + 它自己的工具）：第 0 列在左 */
  const focusCol = '__FOCUS__' === 'peer' ? 1 : 0
  const idleCol = '__FOCUS__' === 'peer' ? 0 : 1
  if (!document.querySelector(`[data-split-column="${focusCol}"] [data-testid="split-live"] .composer-wrap`)) throw new Error('splitview: 焦点一侧没有输入框')
  const idle = document.querySelector(`[data-split-column="${idleCol}"] [data-testid="split-peer"]`)
  if (!idle?.querySelector('[data-testid="split-peer-input"]')) throw new Error('splitview: 非焦点一侧没有输入框外观')
  if (idle.querySelector('[data-testid="composer"]')) throw new Error('splitview: 非焦点一侧不该有可用的输入框')
  /* 两侧输入框同高：焦点换块时版面不跳。焦点那块在运行时顶边框多一行状态、占位文字也不同，只在空闲时比高度 */
  const liveBusy = document.querySelector(`[data-split-column="${focusCol}"] .cborder`)?.dataset.state === 'working'
  if (!idle.querySelector('.cborder')) throw new Error('splitview: 非焦点一侧的输入框外观缺顶边框')
  const liveBox = document.querySelector(`[data-split-column="${focusCol}"] .composer`).getBoundingClientRect().height
  const idleBox = idle.querySelector('.composer').getBoundingClientRect().height
  const parts = (root) => [...root.querySelector('.composer').children, ...root.querySelector('.composer-bar').children].map((c) => `${c.className.split(' ')[0]}:${Math.round(c.getBoundingClientRect().height)}`).join(',')
  if (!liveBusy && Math.abs(liveBox - idleBox) > 2) throw new Error(`splitview: 两侧输入框高度不同 live=${liveBox}[${parts(document.querySelector(`[data-split-column="${focusCol}"]`))}] idle=${idleBox}[${parts(idle)}]`)
  const dim = idle.querySelector('.split-dim')
  if (!dim || getComputedStyle(dim).pointerEvents !== 'none') throw new Error('splitview: 非焦点一侧没有不拦指针的遮罩')
  const nest = document.querySelector(`[data-split-column="${focusCol}"] [data-testid="tool-nest"]`)
  if (!nest || nest.querySelectorAll('[data-testid="tool-row"]').length !== 3) throw new Error('splitview: Codemode 子调用没有嵌在父调用之下')
  const a = document.querySelector('[data-split-column="0"]').getBoundingClientRect()
  const b = document.querySelector('[data-split-column="1"]').getBoundingClientRect()
  const box = (r) => `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`
  if (!(a.right <= b.left + 1) || a.width < 200 || b.width < 200) throw new Error(`splitview: 两侧没有左右并排 chat=${box(a)} peer=${box(b)}`)
  /* 两列之间的分隔条：往右拖 120px，左列变宽、右列变窄 */
  const resizer = document.querySelector('[data-testid="split-resizer"]')
  if (!resizer) throw new Error('splitview: 两列之间没有调宽度的分隔条')
  const rr = resizer.getBoundingClientRect()
  const pd = (type, x) => (type === 'pointerdown' ? resizer : document).dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: rr.top + 200, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, isPrimary: true, pointerType: 'mouse' }))
  pd('pointerdown', rr.left + 1); pd('pointermove', rr.left + 61); pd('pointermove', rr.left + 121); pd('pointerup', rr.left + 121)
  await sleep(200)
  const a2 = document.querySelector('[data-split-column="0"]').getBoundingClientRect().width
  const b2 = document.querySelector('[data-split-column="1"]').getBoundingClientRect().width
  /* 右列已经是它的最小宽度（窄窗口、它那一列带着工具）时让不出宽度，拖不动是对的 */
  const minB = parseFloat(document.querySelector('[data-split-column="1"] .tile-workspace')?.style.minWidth || '340')
  if (b.width - 120 >= minB && !(a2 > a.width + 80 && b2 < b.width - 80)) throw new Error(`splitview: 拖分隔条没改变两列宽度 ${Math.round(a.width)}/${Math.round(b.width)} → ${Math.round(a2)}/${Math.round(b2)}`)
  /* 双击分隔条回到等宽 */
  resizer.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  await sleep(200)
  if (Math.abs(document.querySelector('[data-split-column="0"]').getBoundingClientRect().width - a.width) > 4) throw new Error('splitview: 双击分隔条没回到等宽')
  /* 工具挂在会话旁边：从焦点会话开一个终端，只出现在焦点那一列 */
  window.dispatchEvent(new CustomEvent('inkstone-workspace-launch', { detail: 'terminal' }))
  const t0 = Date.now()
  while (Date.now() - t0 < 6000 && !document.querySelector(`[data-split-column="${focusCol}"] [data-workspace-pane^="terminal:"]:not([hidden])`)) await sleep(100)
  if (!document.querySelector(`[data-split-column="${focusCol}"] [data-workspace-pane^="terminal:"]:not([hidden])`)) throw new Error('splitview: 焦点会话开的终端没出现在它那一列')
  if (document.querySelector(`[data-split-column="${idleCol}"] [data-workspace-pane^="terminal:"]`)) throw new Error('splitview: 焦点会话的终端跑到了另一列')
  await sleep(600)
  return `ok(focus=${focusCol} widths=${Math.round(a.width)}/${Math.round(b.width)})`
})()
