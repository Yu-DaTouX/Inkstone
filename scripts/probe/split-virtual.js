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
  const rowsIn = (col) => document.querySelectorAll(`[data-split-column="${col}"] .stream-row`).length
  await sleep(800)
  /* 分屏时每条会话一列：第 0 列在左 */
  const textIn = (col) => document.querySelector('[data-split-column="' + col + '"] .stream')?.textContent ?? ''
  if (!textIn(0).includes('第 100 个回答')) throw new Error('splitvirtual: 分屏后左侧长会话没有画出最后一轮（虚拟列表空白）')
  /* 逐帧记录换块过程中两列的内容（排查闪烁）：任何一帧变空或换了顶部那一轮都记下来 */
  const frames = []
  let lastSig = '', recording = true
  const frameT0 = performance.now()
  const snapCol = (i) => {
    const col = document.querySelector(`[data-split-column="${i}"]`)
    const st = col?.querySelector('.stream')
    const first = st ? [...st.querySelectorAll('.stream-row')].find((r) => r.getBoundingClientRect().bottom > st.getBoundingClientRect().top + 4) : null
    return `${col?.querySelector('[data-testid="split-live"]') ? 'L' : 'P'} rows=${st?.querySelectorAll('.stream-row').length ?? -1} len=${(st?.textContent ?? '').length} st=${Math.round(st?.scrollTop ?? -1)} top=${(first?.textContent ?? '').slice(0, 8)}`
  }
  const rec = () => { if (!recording) return; const sig = snapCol(0) + ' || ' + snapCol(1); if (sig !== lastSig) { frames.push(Math.round(performance.now() - frameT0) + 'ms ' + sig); lastSig = sig } requestAnimationFrame(rec) }
  requestAnimationFrame(rec)
  setTimeout(() => { recording = false }, 1400)
  split.setState({ split: { tiles: [peerRef, liveRef], live: 1 } })
  await sleep(1500)
  if (!textIn(1).includes('第 100 个回答')) {
    const el = document.querySelector('[data-split-column="1"] .stream')
    const b = el?.getBoundingClientRect()
    throw new Error('splitvirtual: 焦点换边后长会话在新磁贴里一片空白（虚拟列表空白）' + ` el=${!!el} size=${b ? Math.round(b.width) + 'x' + Math.round(b.height) : '-'} scrollTop=${el?.scrollTop} scrollH=${el?.scrollHeight} kids=${el?.firstElementChild?.childElementCount} cls=${el?.className} others=${document.querySelectorAll('.stream').length}`)
  }
  await sleep(200)
  return 'ok(left+swapped) FRAMES ' + frames.join(' | ')
})()
