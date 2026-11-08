import { createServer } from 'node:http'

export const meta = { description: '点击来源链接打开内置浏览器：页面有 8 秒才加载完的资源时，浏览器面板也要立刻出现，不等页面加载完；不调用真实模型' }

export default async function run({ cdp, check, waitFor, sleep, shot, newSession, box, log }) {
  const ev = (expr) => cdp.evaluate(expr)
  const server = createServer((req, res) => {
    if (req.url === '/slow.png') {
      setTimeout(() => { res.writeHead(200, { 'content-type': 'image/gif' }); res.end(Buffer.from('R0lGODlhAQABAAAAACw=', 'base64')) }, 8000)
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><title>slow-page</title><body style="font:32px sans-serif;background:#eef">slow page<img src="/slow.png"></body>')
  })
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
  try {
    await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1500, height: 900, deviceScaleFactor: 1, mobile: false })
    await ev(`window.__yanStore.getState().patchSettings({ theme: 'dark', lang: 'zh-CN', rightPanelOpen: false })`)
    await newSession(box.project)
    const url = `http://127.0.0.1:${port}/`
    const started = Date.now()
    await ev(`window.__yanStore.getState().openLink(${JSON.stringify(url)}); 0`)
    await waitFor(`window.__yanStore.getState().settings?.rightPanelOpen === true && !!document.querySelector('[data-testid="browser-pane-tabs-toggle"]')`, 30000, 25)
    const shown = Date.now() - started
    log('面板出现耗时 ms', shown)
    await shot('browser-open-fast-shown')
    check('慢页面也在 3 秒内出现浏览器面板', shown < 3000, `${shown}ms`)
    await waitFor(`window.__yanStore.getState().browserState.title === 'slow-page'`, 20000, 100)
    const loadedAt = Date.now() - started
    log('标题就绪耗时 ms', loadedAt)
    check('页面最终仍会加载并更新标题', true)
    await waitFor(`window.__yanStore.getState().browserState.loading === false`, 30000, 200)
    check('页面加载完成后状态不再 loading', await ev(`window.__yanStore.getState().browserState.loading === false`))
  } finally {
    server.closeAllConnections?.()
    server.close()
  }
}
