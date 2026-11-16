import { createServer } from 'node:http'

export const meta = { description: '关掉本次启动后的第一个内置浏览器标签，再用别的标签加载网页：主进程不因网络边界回调读到已销毁的标签而崩溃；不调用真实模型' }

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))

export default async function run({ cdp, box, waitFor, check, sleep, log, newSession }) {
  const ev = (expr) => cdp.evaluate(expr)
  let hits = 0
  const server = createServer((req, res) => {
    hits += 1
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><title>page${req.url}</title><body>page ${req.url}<img src="/pixel.png"></body>`)
  })
  const port = await listen(server)
  const url = (path) => `http://127.0.0.1:${port}${path}`
  try {
    await newSession(box.project)
    const sid = await ev(`window.__yanStore.getState().session?.sessionId ?? null`)
    const state = () => ev(`window.yan.browser.getState(${JSON.stringify(sid)}).then((st) => ({ open: st.open, url: st.url, tabs: st.tabs.map((t) => ({ id: t.id, url: t.url })) }))`)
    await ev(`window.yan.browser.open(${JSON.stringify(url('/first'))}, ${JSON.stringify(sid)})`)
    await waitFor(`s.browserState.open`, 30000)
    await ev(`window.yan.browser.newTab(${JSON.stringify(url('/second'))}, ${JSON.stringify(sid)})`)
    await sleep(1500)
    const before = await state()
    log('关之前', before)
    check('开了两个标签', before.tabs.length === 2, before)
    const first = before.tabs.find((tab) => tab.url.includes('/first'))
    await ev(`window.yan.browser.closeTab(${JSON.stringify(first?.id ?? '')}, ${JSON.stringify(sid)})`)
    await sleep(1500)
    const hitsBefore = hits
    await ev(`window.yan.browser.navigate(${JSON.stringify(url('/third'))}, ${JSON.stringify(sid)}).catch((error) => String(error))`)
    await sleep(2500)
    const after = await state()
    log('关掉第一个标签后再加载', { after, hits: hits - hitsBefore })
    check('关掉第一个标签后主进程仍在、剩下的标签照常加载', after.tabs.length === 1 && after.url.includes('/third'), after)
    check('新页面的请求经过网络边界并送达本地服务', hits > hitsBefore, { hits, hitsBefore })
  } finally {
    server.close()
  }
}
