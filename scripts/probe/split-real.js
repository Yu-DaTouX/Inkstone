/*
 * 分屏 + 真实会话文件（`npm run test:live -- splitreal`，需要可见窗口）。
 *
 * 走用户真正的路径：当前在一条短会话（yan-plain-fixture），把长会话（yan-bulk-fixture，200 轮，
 * 走虚拟列表）放到旁边，再点旁边那一侧——焦点换边的同时 `switchSession` 把长会话读进来。
 * 验：换边后焦点那一侧的长会话画得出内容，而不是一片空白。
 */
;(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(100) } return false }
  const store = window.__yanStore
  const split = window.__yanSplit
  store.getState().closeSettings?.()
  await store.getState().refreshSessions()
  const list = store.getState().sessions
  /* 优先用拷进隔离目录的真实会话（排查用户截图里的那两条），没有就用夹具 */
  const byPath = (t) => list.find((s) => s.path.includes(t))
  const plain = byPath('01a11640') ?? byPath('yan-plain-fixture')
  const bulk = byPath('01a115f7') ?? byPath('yan-bulk-fixture')
  const real = !!byPath('01a115f7')
  if (!plain || !bulk) throw new Error(`splitreal: 找不到夹具会话 plain=${!!plain} bulk=${!!bulk} total=${list.length}`)
  split.getState().close()
  await store.getState().switchSession(plain.path)
  await sleep(1500)
  /* 当前会话先滚到底（用户停在会话末尾再去点旁边那一条） */
  const a0 = document.querySelector('.stream')
  const aVirtual = document.querySelectorAll('.stream-row').length > 0
  if (a0) a0.scrollTop = a0.scrollHeight
  await sleep(800)
  split.getState().open({ sessionId: bulk.id, path: bulk.path }, { sessionId: plain.id, path: plain.path })
  await sleep(1500)
  const peer = document.querySelector('[data-testid="split-peer"]')
  if (!peer) throw new Error('splitreal: 旁边没有只读的那一侧')
  /* 点旁边那一侧的空白处 = 切焦点 + switchSession */
  const series = []
  const t0 = Date.now()
  const sample = () => { const live = document.querySelector('[data-testid="split-live"]'); const el = live?.querySelector('.stream'); const w = el?.getBoundingClientRect(); series.push(`${Date.now() - t0}ms[st=${Math.round(el?.scrollTop ?? -1)}/${Math.round(el?.scrollHeight ?? -1)} h=${Math.round(w?.height ?? -1)} kids=${el?.firstElementChild?.childElementCount} txt=${(el?.textContent ?? '').length} act=${(store.getState().session?.sessionFile ?? '').slice(-12)} live=${split.getState().split?.live}]`) }
  const timer = setInterval(sample, 250)
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
  const r = info()
  console.log('SERIES ' + series.join(' '))
  if (r.text.length < 100) throw new Error(`splitreal: 点旁边那一侧后焦点侧一片空白 ${JSON.stringify({ ...r, text: r.text.length })} live=${split.getState().split?.live} active=${store.getState().session?.sessionFile}`)
  /* 对照：不分屏，直接切到同一条长会话，落在哪 */
  split.getState().close()
  await store.getState().switchSession(plain.path)
  await sleep(1200)
  await store.getState().switchSession(bulk.path)
  await sleep(2000)
  const c = document.querySelector('.stream')
  const control = `control(single): st=${Math.round(c?.scrollTop ?? -1)}/${Math.round(c?.scrollHeight ?? -1)} kids=${c?.firstElementChild?.childElementCount} txt=${(c?.textContent ?? '').length}`
  return `${control} || ok(real=${real} aVirtual=${aVirtual} textLen=${r.text.length} size=${r.size} scrollTop=${Math.round(r.scrollTop)} scrollH=${Math.round(r.scrollH)} title=${r.title}) SERIES ${series.join(' ')}`
})()
