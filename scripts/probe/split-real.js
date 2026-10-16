;(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(100) } return false }
  const store = window.__yanStore
  const split = window.__yanSplit
  store.getState().closeSettings?.()
  await store.getState().refreshSessions()
  const list = store.getState().sessions
  const byPath = (t) => list.find((s) => s.path.includes(t))
  const plain = byPath('01a11640') ?? byPath('yan-plain-fixture')
  const bulk = byPath('01a115f7') ?? byPath('yan-bulk-fixture')
  const real = !!byPath('01a115f7')
  if (!plain || !bulk) throw new Error(`splitreal: 找不到夹具会话 plain=${!!plain} bulk=${!!bulk} total=${list.length}`)
  split.getState().close()
  await store.getState().switchSession(plain.path)
  await sleep(1500)
  const a0 = document.querySelector('.stream')
  const aVirtual = document.querySelectorAll('.stream-row').length > 0
  if (a0) a0.scrollTop = a0.scrollHeight
  await sleep(800)
  split.getState().open({ sessionId: bulk.id, path: bulk.path }, { sessionId: plain.id, path: plain.path })
  await sleep(1500)
  const peer = document.querySelector('[data-testid="split-peer"]')
  if (!peer) throw new Error('splitreal: 旁边没有只读的那一侧')
  const series = []
  const t0 = Date.now()
  const peerBlank = []
  const samplePeer = () => { const p = document.querySelector('[data-testid="split-peer"] .stream'); if (p && split.getState().split?.live === 1 && (p.textContent ?? '').length < 20) peerBlank.push(Date.now() - t0) }
  const peerTimer = setInterval(samplePeer, 16)
  const sample = () => { const live = document.querySelector('[data-testid="split-live"]'); const el = live?.querySelector('.stream'); const w = el?.getBoundingClientRect(); series.push(`${Date.now() - t0}ms[st=${Math.round(el?.scrollTop ?? -1)}/${Math.round(el?.scrollHeight ?? -1)} h=${Math.round(w?.height ?? -1)} kids=${el?.firstElementChild?.childElementCount} txt=${(el?.textContent ?? '').length} act=${(store.getState().session?.sessionFile ?? '').slice(-12)} live=${split.getState().split?.live}]`) }
  const timer = setInterval(sample, 250)
  const growAndCheck = async (sel, name) => {
    const st = document.querySelector(`${sel} .stream`)
    if (!st) throw new Error(`splitreal: 找不到${name}的对话区`)
    st.scrollTop = st.scrollHeight
    await sleep(200)
    const pad = document.createElement('div')
    pad.style.height = '400px'
    st.firstElementChild.appendChild(pad)
    await sleep(300)
    const gap = st.scrollHeight - st.scrollTop - st.clientHeight
    pad.remove()
    await sleep(200)
    if (gap > 30) throw new Error(`splitreal: ${name}内容变高后没贴住底部（离底 ${Math.round(gap)}px）`)
  }
  await growAndCheck('[data-testid="split-peer"]', '非焦点块')
  await growAndCheck('[data-testid="split-live"]', '焦点块')
  const anchorOf = () => {
    const st = document.querySelector('[data-split-column="1"] .stream')
    if (!st) return null
    const top = st.getBoundingClientRect().top
    const el = [...st.querySelectorAll('.stream-inner > *, .stream-row')].find((r) => r.getBoundingClientRect().bottom > top + 4)
    const block = el?.querySelector('p, .msg-text, .md, .ubox') ?? el
    const r = block?.getBoundingClientRect()
    return r ? { text: (el.textContent ?? '').slice(0, 24), x: Math.round(r.left), y: Math.round(r.top) } : null
  }
  const before = anchorOf()
  const outlinesBefore = document.querySelectorAll('[data-split-column] .outline').length
  const frames = []
  let lastSig = ''
  const frameT0 = performance.now()
  let recording = true
  const snapCol = (i) => {
    const col = document.querySelector(`[data-split-column="${i}"]`)
    const st = col?.querySelector('.stream')
    const first = st ? [...st.querySelectorAll('.stream-row, .stream-inner > *')].find((r) => r.getBoundingClientRect().bottom > st.getBoundingClientRect().top + 4) : null
    const dim = col?.querySelector('.split-dim')
    const vis = st ? getComputedStyle(st).visibility + '/' + getComputedStyle(st).opacity : '-'
    return `${col?.querySelector('[data-testid="split-live"]') ? 'L' : 'P'} len=${(st?.textContent ?? '').length} st=${Math.round(st?.scrollTop ?? -1)}/${st?.scrollHeight ?? -1} top="${(first?.textContent ?? '').slice(0, 10)}" dim=${dim ? (dim.classList.contains('out') ? 'out' : 'in') + ':' + Number(getComputedStyle(dim).opacity).toFixed(2) : '-'} v=${vis}`
  }
  const rec = () => {
    if (!recording) return
    const sig = `${snapCol(0)} || ${snapCol(1)}`
    if (sig !== lastSig) { frames.push(`${Math.round(performance.now() - frameT0)}ms ${sig}`); lastSig = sig }
    requestAnimationFrame(rec)
  }
  requestAnimationFrame(rec)
  setTimeout(() => { recording = false; console.log('FRAMES\n' + frames.join('\n')) }, 1500)
  peer.click()
  const info = () => {
    const live = document.querySelector('[data-testid="split-live"]')
    const el = live?.querySelector('.stream')
    const b = el?.getBoundingClientRect()
    return { text: el?.textContent ?? '', size: b ? Math.round(b.width) + 'x' + Math.round(b.height) : '-', scrollTop: el?.scrollTop, scrollH: el?.scrollHeight, kids: el?.firstElementChild?.childElementCount, title: live?.querySelector('.shead-title')?.textContent }
  }
  await until(() => store.getState().session?.sessionFile === bulk.path && info().text.length > 100, 9000)
  await sleep(1200)
  clearInterval(timer)
  clearInterval(peerTimer)
  const r = info()
  console.log('SERIES ' + series.join(' '))
  const liveStream = document.querySelector('[data-testid="split-live"] .stream')
  if (liveStream && liveStream.scrollHeight - liveStream.scrollTop - liveStream.clientHeight > 60) throw new Error(`splitreal: 换块后焦点那块没停在底部 st=${Math.round(liveStream.scrollTop)}/${liveStream.scrollHeight}`)
  const after = anchorOf()
  if (!before || !after || before.text !== after.text || Math.abs(before.x - after.x) > 2 || Math.abs(before.y - after.y) > 4) throw new Error(`splitreal: 换块后内容挪位了 before=${JSON.stringify(before)} after=${JSON.stringify(after)}`)
  const gapOf = (col) => { const st = document.querySelector(`[data-split-column="${col}"] .stream`); return st ? Math.round(st.scrollHeight - st.scrollTop - st.clientHeight) : -1 }
  const gaps = []
  for (let round = 0; round < 4; round++) {
    const target = document.querySelector('[data-testid="split-peer"]')
    const col = Number(target.closest('[data-split-column]').dataset.splitColumn)
    const liveCol = 1 - col
    const ls = document.querySelector(`[data-split-column="${liveCol}"] .stream`)
    ls.scrollTop = ls.scrollHeight
    await sleep(300)
    target.click()
    await until(() => !!document.querySelector(`[data-split-column="${col}"] [data-testid="split-live"]`), 6000)
    for (const wait of [50, 400, 1500]) { await sleep(wait); gaps.push(gapOf(liveCol)) }
  }
  if (gaps.some((g) => g < 0 || g > 30)) throw new Error(`splitreal: 来回切焦点后失焦的那块没停在底部（离底 ${gaps.join(',')}px）`)
  {
    const liveTile = split.getState().split.tiles[split.getState().split.live]
    const full = store.getState().messages
    const lastText = (full.filter((m) => m.role === 'assistant' && m.text).at(-1)?.text ?? '').replace(/\s+/g, '').slice(-12)
    const stale = [...full.slice(0, -4), ...full.slice(0, 12).map((m, i) => ({ ...m, id: `stale-${i}`, timestamp: 1 }))]
    const prev = store.getState().sessionRuntimes[liveTile.sessionId]
    store.setState({ sessionRuntimes: { ...store.getState().sessionRuntimes, [liveTile.sessionId]: { ...(prev ?? { uiRequests: [], draft: '' }), messages: stale } } })
    document.querySelector('[data-testid="split-peer"]').click()
    await sleep(1500)
    const peerText = (document.querySelector('[data-testid="split-peer"] .stream')?.textContent ?? '').replace(/\s+/g, '')
    if (prev) store.setState({ sessionRuntimes: { ...store.getState().sessionRuntimes, [liveTile.sessionId]: prev } })
    if (lastText && !peerText.includes(lastText)) throw new Error(`splitreal: 运行缓存是旧版本时，失焦的那块少了最后一轮（找不到「${lastText}」）`)
  }
  const openRows = document.querySelectorAll('.srow-row[data-split-open]').length
  const selRows = document.querySelectorAll('.srow-row.selected').length
  if (openRows < 2 || selRows < 1) throw new Error(`splitreal: 左栏没标出分屏里打开的会话 open=${openRows} selected=${selRows}`)
  const hLive = document.querySelector('[data-testid="split-live"] .composer')?.getBoundingClientRect().height ?? 0
  const hPeer = document.querySelector('[data-testid="split-peer"] .composer')?.getBoundingClientRect().height ?? 0
  if (Math.abs(hLive - hPeer) > 2) throw new Error(`splitreal: 两块输入框高度不同 live=${hLive} peer=${hPeer}`)
  if (peerBlank.length) throw new Error(`splitreal: 失焦的一块在换块时空白过 ${peerBlank.slice(0, 5).join(',')}ms`)
  const active = document.activeElement
  if (!(active?.matches?.('[data-testid="composer"]') && active.closest('[data-testid="split-live"]'))) throw new Error(`splitreal: 换块后光标不在输入框里 active=${active?.tagName}.${active?.className}`)
  if (r.text.length < 100) throw new Error(`splitreal: 点旁边那一侧后焦点侧一片空白 ${JSON.stringify({ ...r, text: r.text.length })} live=${split.getState().split?.live} active=${store.getState().session?.sessionFile}`)
  split.getState().close()
  await store.getState().switchSession(plain.path)
  await sleep(1200)
  await store.getState().switchSession(bulk.path)
  await sleep(2000)
  const c = document.querySelector('.stream')
  const control = `control(single): st=${Math.round(c?.scrollTop ?? -1)}/${Math.round(c?.scrollHeight ?? -1)} kids=${c?.firstElementChild?.childElementCount} txt=${(c?.textContent ?? '').length}`
  await sleep(400)
  return `ANCHOR ${JSON.stringify(before)} -> ${JSON.stringify(after)} outlines=${outlinesBefore} ;; FRAMES ${frames.join(" | ")} ;; ${control} || ok(real=${real} aVirtual=${aVirtual} textLen=${r.text.length} size=${r.size} scrollTop=${Math.round(r.scrollTop)} scrollH=${Math.round(r.scrollH)} title=${r.title}) SERIES ${series.join(' ')}`
})()
