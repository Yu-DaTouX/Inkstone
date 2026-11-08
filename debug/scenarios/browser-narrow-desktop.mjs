import { createServer } from 'node:http'

export const meta = { description: '窄的内置浏览器面板仍用电脑版网页：面板宽度小于 600 时页面的 UA 不含 Mobile，也不被重载成手机版（页内宽度受调试用的窗口模拟影响，不作判断）；不调用真实模型' }

export default async function run({ cdp, check, waitFor, sleep, newSession, box, log }) {
  const ev = (expr) => cdp.evaluate(expr)
  const seen = []
  const server = createServer((req, res) => {
    if (req.url === '/') seen.push(String(req.headers['user-agent'] ?? ''))
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><title>ua-probe</title><body><script>const t = () => { document.title = (/Mobile|Android/.test(navigator.userAgent) ? "mobile" : "desktop") + ":" + innerWidth }; t(); addEventListener("resize", t)</script>probe</body>')
  })
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
  try {
    await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1125, height: 1000, deviceScaleFactor: 1, mobile: false })
    await ev(`window.__yanStore.getState().patchSettings({ theme: 'dark', lang: 'zh-CN', rightPanelOpen: true })`)
    await newSession(box.project)
    await ev(`window.__yanStore.getState().openLink('http://127.0.0.1:${port}/')`)
    await waitFor(`window.__yanStore.getState().browserState.title?.includes(':')`, 20000, 100)
    await sleep(2500)
    const paneWidth = await ev(`Math.round(document.querySelector('[data-testid="browser-pane-viewport"]').getBoundingClientRect().width)`)
    const title = await ev(`window.__yanStore.getState().browserState.title`)
    log('面板宽度', paneWidth)
    log('页面标题', title)
    log('请求 UA', seen)
    check('面板确实比 600 窄', paneWidth < 600, String(paneWidth))
    check('页面按电脑版加载', String(title).startsWith('desktop:'), String(title))
    check('所有请求的 UA 都不含 Mobile', seen.length > 0 && seen.every((ua) => !/Mobile|Android/.test(ua)), seen.join(' | '))
  } finally {
    server.close()
  }
}
