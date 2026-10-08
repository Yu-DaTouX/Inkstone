/*
 * 分屏 + 「只读打开」（`npm run test:live -- splitdeferred`，需要可见窗口；用 YAN_TEST_EXTRA_SESSIONS 拷入的真实会话更有说服力）。
 *
 * 同一工作目录里已有忙实例时，点另一侧的 `switchSession` 走 deferred：运行实例仍是原来那条，
 * 屏幕上的内容只是 peek 铺的。这里直接复现那个状态：当前会话在跑（isAgentRunning），
 * 把长会话的 peek 内容与 peekedPath 写进 store，再让分屏焦点换到它。验：焦点侧画得出正文。
 */
;(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const store = window.__yanStore
  const split = window.__yanSplit
  store.getState().closeSettings?.()
  await store.getState().refreshSessions()
  const list = store.getState().sessions
  const byPath = (t) => list.find((s) => s.path.includes(t))
  const plain = byPath('01a11640') ?? byPath('yan-plain-fixture')
  const bulk = byPath('01a115f7') ?? byPath('yan-bulk-fixture')
  if (!plain || !bulk) throw new Error('splitdeferred: 找不到夹具会话')
  split.getState().close()
  await store.getState().switchSession(plain.path)
  await sleep(1500)
  split.getState().open({ sessionId: bulk.id, path: bulk.path }, { sessionId: plain.id, path: plain.path })
  await sleep(1200)
  const peek = await window.yan.peekSession(bulk.path)
  const s0 = store.getState().session
  store.setState({
    session: { ...s0, isAgentRunning: true },
    messages: peek.messages,
    peekedPath: bulk.path,
    peekedSessionId: bulk.id,
    pendingActivation: { sessionFile: bulk.path, sessionId: bulk.id, cwd: s0?.cwd ?? '' }
  })
  const series = []
  const t0 = Date.now()
  const info = () => {
    const live = document.querySelector('[data-testid="split-live"]')
    const el = live?.querySelector('.stream')
    const box = el?.getBoundingClientRect()
    const rows = [...(el?.querySelectorAll('.stream-row') ?? [])]
    const seen = rows.filter((r) => { const b = r.getBoundingClientRect(); return b.height > 0 && b.bottom > (box?.top ?? 0) && b.top < (box?.bottom ?? 0) }).length
    const inner = el?.querySelector('.stream-inner')?.getBoundingClientRect()
    const chain = []
    for (let n = el; n; n = n.parentElement) if (n.scrollLeft) chain.push(`${n.className.toString().slice(0, 24)}:${Math.round(n.scrollLeft)}`)
    const cx = box ? document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) : null
    return `${Date.now() - t0}ms[win=${innerWidth} box=${Math.round(box?.left ?? -1)}..${Math.round(box?.right ?? -1)} inner=${Math.round(inner?.left ?? -1)}..${Math.round(inner?.right ?? -1)} sl=${chain.join('|')} mid=${cx?.tagName}.${String(cx?.className).slice(0, 20)} live=${split.getState().split?.live} h=${Math.round(box?.height ?? -1)} st=${Math.round(el?.scrollTop ?? -1)}/${Math.round(el?.scrollHeight ?? -1)} rows=${rows.length} inView=${seen} txt=${(el?.textContent ?? '').length} title=${live?.querySelector('.shead-title')?.textContent}]`
  }
  for (let i = 0; i < 12; i++) { series.push(info()); await sleep(400) }
  const liveEl = document.querySelector('[data-testid="split-live"] .stream')
  const lim = liveEl.getBoundingClientRect().right
  const tall = [...liveEl.querySelectorAll('*')].map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.width), e.tagName + '.' + String(e.className).slice(0, 36) + '|' + getComputedStyle(e).whiteSpace + '|' + getComputedStyle(e).display, Math.round(r.right - lim)] }).filter((x) => x[2] > 20).sort((a, b) => b[0] - a[0]).slice(0, 10)
  { const si = liveEl.querySelector('.stream-inner'); const cs = getComputedStyle(si); const ps = getComputedStyle(liveEl); series.push('CS ' + JSON.stringify({ w: cs.width, mw: cs.maxWidth, minw: cs.minWidth, disp: cs.display, ml: cs.marginLeft, pad: cs.paddingLeft, streamDisp: ps.display, streamW: ps.width, wstream: ps.getPropertyValue('--w-stream'), contain: cs.contain, sw: liveEl.scrollWidth, cw: liveEl.clientWidth })) }
  series.push('TALL ' + JSON.stringify(tall))
  const last = info()
  const m = /txt=(\d+)/.exec(last)
  const lb = liveEl.getBoundingClientRect(), ib = liveEl.querySelector('.stream-inner, .stream-row')?.getBoundingClientRect()
  /* 正文列必须落在自己的对话区里：导航轨避让量曾被别的磁贴的 .stream 算成上千像素，正文被推出可视区 */
  if (ib && (ib.right > lb.right + 2 || ib.left < lb.left - 2)) throw new Error(`splitdeferred: 正文被推出对话区 stream=${Math.round(lb.left)}..${Math.round(lb.right)} inner=${Math.round(ib.left)}..${Math.round(ib.right)}`)
  if (!m || Number(m[1]) < 100) throw new Error('splitdeferred: 焦点侧白屏 ' + series.join(' '))
  return 'ok ' + series.join(' ')
})()
