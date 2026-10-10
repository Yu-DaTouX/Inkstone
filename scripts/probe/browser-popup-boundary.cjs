const { app, BrowserWindow } = require('electron')
const { createServer } = require('node:http')
const { mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { pathToFileURL } = require('node:url')
const assert = require('node:assert/strict')
app.setPath('userData', mkdtempSync(join(tmpdir(), 'inkstone-popup-boundary-')))
app.commandLine.appendSwitch('host-resolver-rules', 'MAP audit.invalid 127.0.0.1')
app.commandLine.appendSwitch('no-proxy-server')
const hits = []
const server = createServer((req, res) => {
  hits.push(req.url)
  if (req.url === '/redirect') { res.writeHead(302, { location: `http://127.0.0.1:${server.address().port}/redirect-private` }); res.end(); return }
  res.setHeader('content-type', 'text/html')
  res.end('<!doctype html><title>Boundary fixture</title><p>Synthetic page</p>')
})
let controller, win
const pause = () => new Promise(done => setTimeout(done, 350))
;(async () => {
  await app.whenReady()
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const port = server.address().port
  const { BrowserController } = await import(pathToFileURL(resolve('out/test/browser-popup.mjs')).href)
  win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  controller = new BrowserController(() => win, () => {})
  await controller.open(`http://audit.invalid:${port}/public`)
  const source = [...controller.tabs.values()][0].view.webContents
  assert.equal(await source.executeJavaScript(`fetch('http://127.0.0.1:${port}/direct-private').then(()=>true).catch(()=>false)`), false)
  await source.executeJavaScript(`window.open('http://127.0.0.1:${port}/popup-private');true`, true)
  await pause()
  assert.equal(hits.includes('/popup-private'), false)
  await source.executeJavaScript(`window.open('http://audit.invalid:${port}/public-popup');true`, true)
  await pause()
  assert.equal(hits.includes('/public-popup'), true)
  await source.executeJavaScript(`window.open('http://audit.invalid:${port}/redirect');true`, true)
  await pause()
  assert.equal(hits.includes('/redirect-private'), false)
  // A host-requested public first navigation also cannot redirect to private addresses.
  await controller.newTab(`http://audit.invalid:${port}/redirect`).catch(() => {})
  await pause()
  assert.equal(hits.includes('/redirect-private'), false)
  // Explicit local previews stay usable, including while a remote popup is opening.
  await Promise.all([
    source.executeJavaScript(`window.open('http://127.0.0.1:${port}/concurrent-private');true`, true),
    controller.newTab(`http://127.0.0.1:${port}/explicit-local`)
  ])
  await pause()
  assert.equal(hits.includes('/concurrent-private'), false)
  assert.equal(hits.includes('/explicit-local'), true)
  console.log('PASS: actual Electron popup/redirect/private source boundary; public popup and explicit local preview; per-tab concurrent navigation')
  console.log(JSON.stringify({ hits, tabs: controller.getState().tabs.length }))
  await controller.close(); win.destroy(); server.close(); app.exit(0)
})().catch(async error => {
  console.error(error)
  if (controller) await controller.close().catch(() => {})
  if (win && !win.isDestroyed()) win.destroy()
  server.close(); app.exit(1)
})
setTimeout(() => app.exit(2), 20000).unref()
