import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const meta = { description: '本地服务发现：agent 在会话终端里起的 dev server 出现在列表里并带停止按钮，用户自己起的没有；点停止后服务消失；不调用真实模型' }

const SERVER = `import { createServer } from 'node:http'
const port = Number(process.argv[2])
createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end('<!doctype html><title>agent-dev-server</title><body style="font:32px sans-serif;background:#efe">agent dev server</body>')
}).listen(port, '127.0.0.1')
`

const freePort = () => new Promise((resolve) => {
  const server = createServer()
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address()
    server.close(() => resolve(port))
  })
})

export default async function run({ cdp, box, waitFor, check, sleep, shot, log, newSession, turn }) {
  const ev = (expr) => cdp.evaluate(expr)
  const mine = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><title>user-own-server</title><body>user</body>')
  })
  const minePort = await new Promise((resolve) => mine.listen(0, '127.0.0.1', () => resolve(mine.address().port)))
  const devPort = await freePort()
  writeFileSync(join(box.project, 'dev-server.mjs'), SERVER)
  try {
    await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1500, height: 900, deviceScaleFactor: 1, mobile: false })
    await ev(`window.__yanStore.getState().patchSettings({ theme: 'dark', lang: 'zh-CN', rightPanelOpen: true })`)
    await newSession(box.project)
    await turn(`DEVSERVER DEVSCRIPT=dev-server.mjs DEVPORT=${devPort}`, { timeout: 90000 })
    await sleep(1000)
    await waitFor(`!!document.querySelector('[data-testid="browser-pane-tabs-toggle"]')`, 20000)
    await ev(`localStorage.setItem('inkstone.browser.tabsPinned', '1'), document.querySelector('[data-testid="browser-pane-tabs-toggle"]').getAttribute('aria-pressed') === 'true' ? 0 : document.querySelector('[data-testid="browser-pane-tabs-toggle"]').click()`)
    await sleep(600)
    const rows = () => ev(`[...document.querySelectorAll('[data-testid="browser-local-server-row"]')].map((r) => ({ title: r.title, text: r.innerText.replace(/\s+/g, ' ').trim(), stop: !!r.querySelector('[data-testid="browser-local-server-stop"]') }))`)
    await waitFor(`document.querySelectorAll('[data-testid="browser-local-server-row"]').length >= 2`, 20000)
    const before = await rows()
    log('列表', before)
    const mineRow = before.find((r) => r.title.includes(String(minePort)))
    const devRow = before.find((r) => r.title.includes(String(devPort)))
    check('两个服务都被发现', !!mineRow && !!devRow, before)
    check('agent 起的服务有停止按钮', devRow?.stop === true, devRow)
    check('用户自己起的服务没有停止按钮', mineRow?.stop === false, mineRow)
    await ev(`window.__yanStore.getState().setRightPanelOpen(true)`)
    await sleep(300)
    const rowBox = await ev(`(() => { const r = [...document.querySelectorAll('[data-testid="browser-local-server-row"]')].find((x) => x.title.includes('${devPort}')); if (!r) return null; r.scrollIntoView({ block: 'center' }); const b = r.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 } })()`)
    check('能定位到 agent 服务那一行', !!rowBox, rowBox)
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rowBox.x, y: rowBox.y })
    await sleep(400)
    await shot('rows-hover')
    const stopBox = await ev(`(() => { const r = [...document.querySelectorAll('[data-testid="browser-local-server-row"]')].find((x) => x.title.includes('${devPort}')); const b = r?.querySelector('[data-testid="browser-local-server-stop"]')?.getBoundingClientRect(); return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width } : null })()`)
    check('悬停后停止按钮可见', !!stopBox && stopBox.w > 0, stopBox)
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: stopBox.x, y: stopBox.y })
    await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, x: stopBox.x, y: stopBox.y })
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, x: stopBox.x, y: stopBox.y })
    await waitFor(`![...document.querySelectorAll('[data-testid="browser-local-server-row"]')].some((r) => r.title.includes('${devPort}'))`, 20000)
    const after = await rows()
    log('停止后', after)
    check('点停止后 agent 的服务从列表消失', !after.some((r) => r.title.includes(String(devPort))))
    check('用户自己的服务没受影响', after.some((r) => r.title.includes(String(minePort))), after)
    const reachable = await fetch(`http://127.0.0.1:${devPort}/`).then(() => true).catch(() => false)
    check('端口确实不再响应', !reachable)
    const mineAlive = await fetch(`http://127.0.0.1:${minePort}/`).then(() => true).catch(() => false)
    check('用户服务仍然响应', mineAlive)
    await shot('after-stop')
  } finally {
    mine.close()
  }
}
