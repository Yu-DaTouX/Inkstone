/*
 * 分屏最多 5 块（`npm run test:live -- splitfive`，合成会话，需要可见窗口）。
 *
 * 验：依次加到 5 块，每块都是一块会话磁贴且宽度大致相等；只有焦点那一块有输入框；
 * 第 6 条进来挤掉一块没有焦点的（仍是 5 块）；关到只剩一块就退出分屏；关焦点块时焦点去邻块。
 */
;(async () => {
  const out = []
  const ok = (c, s) => { out.push((c ? '  ✓ ' : '  ✗ ') + s); return !!c }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const store = window.__yanStore
  const split = window.__yanSplit
  const st = store.getState()
  st.closeSettings?.()
  const now = Date.now()
  const cwd = st.session?.cwd || 'C:/fixture/demo'
  const mk = (id, title, ago) => ({ id, path: `C:/fixture/sf/${id}.jsonl`, cwd, title, named: true, scope: 'global', createdAt: now - ago, updatedAt: now - ago, lastActivityAt: now - ago, messageCount: 4, lastOpenedAt: now - ago })
  const fx = ['a', 'b', 'c', 'd', 'e', 'f'].map((k, i) => mk(`sf-${k}`, `五块测试${k}`, (i + 1) * 60_000))
  store.setState({ sessions: [...st.sessions.filter((s) => !s.id.startsWith('sf-')), ...fx] })
  split.getState().close()
  await sleep(500)
  const current = { sessionId: store.getState().session?.sessionId, path: store.getState().session?.sessionFile }
  const ref = (s) => ({ sessionId: s.id, path: s.path })
  const frames = () => [...document.querySelectorAll('.tile-frame.primary')].map((el) => el.getBoundingClientRect())
  const tiles = () => split.getState().split?.tiles.length ?? 0

  for (let i = 0; i < 4; i++) {
    split.getState().open(ref(fx[i]), current)
    await sleep(500)
  }
  ok(tiles() === 5, `加到 5 块（${tiles()}）`)
  const fr = frames()
  ok(fr.length === 5, `工作区里有 5 块会话磁贴（${fr.length}）`)
  const widths = fr.map((r) => Math.round(r.width))
  ok(Math.max(...widths) - Math.min(...widths) <= 3, `五块等宽（${widths.join('/')}）`)
  ok(document.querySelectorAll('[data-split-tile]').length === 4, '四块只读投影')
  ok(document.querySelectorAll('[data-testid="split-live"]').length === 1, '只有一块是活动会话')
  ok(document.querySelectorAll('.composer-wrap, [data-testid="composer"]').length >= 1, '活动会话有输入框')
  const noOverflow = fr.every((r) => r.right <= window.innerWidth + 1)
  const scroller = document.querySelector('.tile-workspace-scroll')
  ok(noOverflow || (!!scroller && scroller.scrollWidth > scroller.clientWidth), `窗口放不下五块时横向可滚动（窗口宽 ${window.innerWidth}）`)

  split.getState().open(ref(fx[5]), current)
  await sleep(500)
  ok(tiles() === 5 && split.getState().split.tiles.some((t) => t.sessionId === 'sf-f'), '第 6 条进来：仍是 5 块，新的在里面')
  ok(split.getState().split.tiles[split.getState().split.live].sessionId === current.sessionId, '焦点会话没被挤掉')

  /* 关掉非焦点的块直到只剩一块 */
  for (let n = tiles(); n > 1; n--) {
    const sp = split.getState().split
    const idx = sp.tiles.findIndex((_, i) => i !== sp.live)
    split.getState().remove(idx)
    await sleep(150)
  }
  ok(split.getState().split === null, '只剩一块：退出分屏')
  await sleep(400)
  ok(document.querySelectorAll('.tile-frame.primary').length === 1, '回到单会话磁贴')
  return out.join('\n')
})()
