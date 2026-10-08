/*
 * 分屏 + 长会话（虚拟列表）探针（`npm run test:live -- splitvirtual`，需要可见窗口，合成数据）。
 *
 * 复现：当前会话很长（回合数超过虚拟化阈值）时，分屏把焦点换到另一侧，
 * 对话列在新磁贴里重新挂载，虚拟列表必须仍然画得出最后几轮，不能留一片空白。
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
  if (!liveRef.sessionId && !liveRef.path) throw new Error('splitvirtual: 没有当前会话')
  const peerId = 'split-virtual-peer'
  const peerRef = { sessionId: peerId, path: 'C:/fixture/split-virtual-peer.jsonl' }
  const long = []
  for (let i = 0; i < 100; i++) {
    long.push({ id: `sv-u${i}`, role: 'user', text: `第 ${i + 1} 个问题：这一段要足够长，才能让每个回合有真实高度。`, timestamp: now - (200 - i) * 60_000 })
    long.push({ id: `sv-a${i}`, role: 'assistant', text: `第 ${i + 1} 个回答。\n\n这是一段多行的回答，用来撑出高度。\n\n- 要点一\n- 要点二\n- 要点三`, timestamp: now - (200 - i) * 60_000 + 5_000 })
  }
  store.setState({
    sessions: [...st.sessions.filter((s) => s.id !== peerId), { ...(st.sessions[0] ?? {}), id: peerId, path: peerRef.path, title: '另一条会话', updatedAt: now, lastActivityAt: now }],
    sessionRuntimes: {
      ...st.sessionRuntimes,
      [peerId]: {
        runtime: { runId: 'split-virtual-run', sessionId: peerId, generation: 1 },
        session: { ...(live ?? {}), sessionId: peerId, sessionFile: peerRef.path, isAgentRunning: false, isStreaming: false },
        messages: [{ id: 'pv-u', role: 'user', text: '旁边这条很短。', timestamp: now - 1000 }, { id: 'pv-a', role: 'assistant', text: '好的。', timestamp: now - 500 }],
        uiRequests: [],
        queue: { steering: [], followUp: [] }
      }
    },
    messages: []
  })
  /* 长会话走真实的同步通道（与 probe/virtual.js 一致），而不是直接改 store.messages */
  store.getState().applyPush({ ch: 'sync', payload: long })
  await sleep(1200)
  /* 先滚到底（贴底状态），这是用户在长会话里最常见的位置 */
  const first = document.querySelector('.stream')
  if (first) first.scrollTop = first.scrollHeight
  await sleep(800)
  const singleText = document.querySelector('.stream')?.textContent ?? ''
  if (!singleText.includes('第 100 个回答')) throw new Error(`splitvirtual: 没分屏时长会话就没画出内容（len=${singleText.length} msgs=${store.getState().messages.length} turns=${document.querySelectorAll('.stream-row').length}）`)
  /* 先让当前会话在主会话位（左），再把焦点换到旁边那一侧：长会话的对话列要整个搬到右边重新挂载 */
  split.getState().close()
  split.getState().open(peerRef, liveRef)
  await sleep(600)
  const rowsIn = (pane) => document.querySelectorAll(`[data-workspace-pane="${pane}"] .stream-row`).length
  await sleep(800)
  const textIn = (pane) => document.querySelector('[data-workspace-pane="' + pane + '"] .stream')?.textContent ?? ''
  if (!textIn('chat').includes('第 100 个回答')) throw new Error('splitvirtual: 分屏后左侧长会话没有画出最后一轮（虚拟列表空白）')
  split.setState({ split: { tiles: [peerRef, liveRef], live: 1 } })
  await sleep(1500)
  if (!textIn('chat-peer').includes('第 100 个回答')) {
    const el = document.querySelector('[data-workspace-pane="chat-peer"] .stream')
    const b = el?.getBoundingClientRect()
    throw new Error('splitvirtual: 焦点换边后长会话在新磁贴里一片空白（虚拟列表空白）' + ` el=${!!el} size=${b ? Math.round(b.width) + 'x' + Math.round(b.height) : '-'} scrollTop=${el?.scrollTop} scrollH=${el?.scrollHeight} kids=${el?.firstElementChild?.childElementCount} cls=${el?.className} others=${document.querySelectorAll('.stream').length}`)
  }
  return 'ok(left+swapped)'
})()
