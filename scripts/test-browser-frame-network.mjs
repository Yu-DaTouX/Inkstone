import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import { appendFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const electron = process.versions.electron ? createRequire(import.meta.url)('electron') : null
electron?.app.on('window-all-closed', () => {})

async function main() {
  if (!process.versions.electron) {
    const { build } = await import('esbuild')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-frame-network-'))
    const entry = path.join(dir, 'fixture.cjs')
    await build({ entryPoints: [import.meta.filename], outfile: entry, bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'esbuild'], define: { 'import.meta.filename': JSON.stringify(import.meta.filename), 'import.meta.url': JSON.stringify(import.meta.url) } })
    const require = createRequire(import.meta.url)
    const env = { ...process.env, ELECTRON_ENABLE_LOGGING: '1', BROWSER_FIXTURE_LOG: path.join(dir, 'result.log'), BROWSER_FIXTURE_DATA: path.join(dir, 'data') }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(require('electron'), [entry, '--disable-gpu', '--enable-logging=file', `--log-file=${path.join(dir, 'chromium.log')}`], { env, stdio: 'inherit' })
    const timeout = setTimeout(() => child.kill(), 45000)
    process.exitCode = await new Promise((resolve) => child.on('exit', (code) => resolve(code ?? 1)))
    clearTimeout(timeout)
    console.log('fixture exit', process.exitCode, entry)
    console.log(await fs.readFile(env.BROWSER_FIXTURE_LOG, 'utf8').catch(() => 'No fixture log'))
    if (process.exitCode) console.log(await fs.readFile(path.join(dir, 'chromium.log'), 'utf8').catch(() => 'No Chromium log'))
  } else {
    const log = value => appendFileSync(process.env.BROWSER_FIXTURE_LOG, `${value}\n`)
    await log('Electron fixture started')
    const { app, BrowserWindow, WebContentsView } = electron
    const { CDPBridge } = await import('../src/main/browser/CDPBridge.ts')
    const { Observer } = await import('../src/main/browser/Observer.ts')
    const { ElementRegistry } = await import('../src/main/browser/ElementRegistry.ts')
    const { InputController } = await import('../src/main/browser/InputController.ts')
    const { NetworkTracker } = await import('../src/main/browser/NetworkTracker.ts')
    log('helpers imported')
    mkdirSync(process.env.BROWSER_FIXTURE_DATA, { recursive: true })
    app.setPath('userData', process.env.BROWSER_FIXTURE_DATA)
    const server = http.createServer((req, res) => {
      const route = new URL(req.url, 'http://localhost').pathname
      res.setHeader('Content-Type', 'text/html')
      if (route === '/browser-fixture') res.end(`<!doctype html><output id="result">waiting</output><iframe src="/browser-fixture-inner"></iframe><iframe src="http://localhost:${server.address().port}/browser-fixture-cross?private=fixture-secret"></iframe><script>addEventListener('message',e=>{if(e.data==='YAN_FRAME_SUBMITTED'){document.querySelector('#result').textContent='frame submitted';fetch('/browser-fixture-network?private=fixture-secret')}})</script>`)
      else if (route === '/browser-fixture-inner') res.end('<!doctype html><select aria-label="same-choice"><option value="a">A</option><option value="b">B</option></select>')
      else if (route === '/browser-fixture-cross') res.end('<!doctype html><select aria-label="cross-choice"><option value="a">A</option><option value="b">B</option></select><button onclick="parent.postMessage(\'YAN_FRAME_SUBMITTED\',\'*\')">Continue frame</button>')
      else res.end('network-ok')
    })
    log('server starting')
    await new Promise(resolve => server.listen(0, resolve))
    let win
    let contents
    try {
      log('waiting for app')
      await app.whenReady()
      log('app ready')
      win = new BrowserWindow({ show: false, width: 900, height: 600 })
      const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
      win.contentView.addChildView(view)
      view.setBounds({ x: 0, y: 0, width: 320, height: 480 })
      contents = view.webContents
      const cdp = new CDPBridge(contents)
      const registry = new ElementRegistry()
      const observer = new Observer(cdp, registry)
      const input = new InputController(cdp)
      const network = new NetworkTracker(cdp)
      await contents.loadURL('about:blank')
      log('starting network')
      await network.start()
      log('network started')
      const origin = `http://127.0.0.1:${server.address().port}`
      await contents.loadURL(`${origin}/browser-fixture`)
      log('page loaded')
      const observation = await observer.capture(origin, '')
      await log(`observation ${JSON.stringify(observation)}`)
      const same = observation.elements.find(e => e.name === 'same-choice')
      const cross = observation.elements.find(e => e.name === 'cross-choice')
      const button = observation.elements.find(e => e.name === 'Continue frame')
      assert.ok(same, 'same-origin select observed')
      assert.ok(cross?.frameId, 'cross-origin select observed with frame ID')
      assert.equal(cross.frameUrl, `http://localhost:${server.address().port}/browser-fixture-cross`, 'frame URL redacted')
      assert.ok(button?.frameId, 'cross-origin button observed with frame ID')
      assert.equal((await input.select(registry.resolve(same.ref), 'b')).value, 'b')
      assert.equal((await input.select(registry.resolve(cross.ref), 'b')).value, 'b')
      await input.click(registry.resolve(button.ref))
      let updated = false
      for (let i = 0; i < 40; i++) {
        if (await contents.executeJavaScript("document.querySelector('#result').textContent === 'frame submitted'")) { updated = true; break }
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      assert.ok(updated, 'real click updates parent through postMessage')
      for (let i = 0; i < 40 && !network.snapshot().entries.some(e => e.resourceType === 'Fetch' && e.state === 'finished'); i++) await new Promise(resolve => setTimeout(resolve, 50))
      await log(`network ${JSON.stringify(network.snapshot())}`)
      assert.ok(network.snapshot().entries.some(e => e.resourceType === 'Fetch' && e.method === 'GET' && e.status === 200 && e.state === 'finished'), 'Fetch request AND response AND completion captured')
      assert.ok(network.snapshot().entries.every(e => new URL(e.url).pathname === '/' && !e.url.includes('private=')), 'network preserves origin-only privacy')
      const observe = () => observer.capture(contents.getURL(), '')
      const browser = {
        observe,
        network: async () => network.snapshot(),
        select: async (ref, value) => { await input.select(registry.resolve(ref), value); return { ok: true, observation: await observe() } },
        click: async ref => { await input.click(registry.resolve(ref)); return { ok: true, observation: await observe() } }
      }
      const state = { settings: { rightPanelOpen: true }, openBrowser: url => contents.loadURL(url), browserState: {}, messages: [] }
      const fixtureYan = (actions) => ({ browser: actions, runBash: async command => {
        let output
        if (command.startsWith('node -e')) {
          const quoted = [...command.matchAll(/"([^"]*)"/g)].map(match => match[1])
          output = await fs.readFile(quoted.at(-1), 'utf8')
        } else {
          const tokens = [...command.matchAll(/"([^"]*)"|([^\s]+)/g)].map(match => match[1] ?? match[2])
          const action = tokens[2]
          const value = flag => tokens[tokens.indexOf(flag) + 1]
          const data = action === 'observe' ? await actions.observe()
            : action === 'select' ? await actions.select(value('--ref'), value('--value'))
            : await actions.click(value('--ref'))
          const resultFile = path.join(process.env.BROWSER_FIXTURE_DATA, 'action.json')
          await fs.writeFile(resultFile, JSON.stringify(data))
          output = JSON.stringify({ ok: data.ok !== false, resultFile })
        }
        state.messages.push({ role: 'bash', bash: { exitCode: 0 }, toolCalls: [{ status: 'ok', output }] })
      } })
      const probePath = fileURLToPath(new URL('./probe/browser-boundary.js', import.meta.url))
      const probe = (await fs.readFile(probePath, 'utf8')).replaceAll('39873', String(server.address().port))
      const result = await vm.runInNewContext(probe, {
        window: { __yanBrowserFrameNetworkOnly: true, __yanStore: { getState: () => state }, yan: fixtureYan(browser) },
        document: { querySelector: () => null, querySelectorAll: () => [] }, localStorage: { setItem() {} }, setTimeout
      })
      log(result)
      assert.ok(!result.includes('✗'), 'actual local-only boundary probe passes every existing assertion')
      assert.ok(result.includes('✓ 全部通过'), 'probe reaches its end')
      const negativeBrowser = { ...browser, click: async () => ({ ok: true, observation: await observe() }) }
      const negative = await vm.runInNewContext(probe, {
        window: { __yanBrowserFrameNetworkOnly: true, __yanStore: { getState: () => state }, yan: fixtureYan(negativeBrowser) },
        document: { querySelector: () => null, querySelectorAll: () => [] }, localStorage: { setItem() {} }, setTimeout
      })
      assert.ok(negative.includes('✗ 跨源 iframe 表单点击通过 postMessage 更新了父页面'), 'async poll rejects a missing postMessage')
      assert.ok(negative.includes('✗ network 收到页面请求及响应状态'), 'previous Fetch cannot satisfy this click')
      log('PASS: no-op click negative control rejects missing postMessage and reused network entry')
      observer.dispose()
      await log('PASS: eight frame/network assertions plus real postMessage/privacy and actual local-only probe')
    } catch (error) { await log(error.stack); process.exitCode = 1 }
    finally { contents?.close(); win?.destroy(); await new Promise(resolve => server.close(resolve)); app.exit(process.exitCode ?? 0) }
  }
}
main().catch(async error => { console.error(error); if (process.env.BROWSER_FIXTURE_LOG) appendFileSync(process.env.BROWSER_FIXTURE_LOG, error.stack); process.exitCode = 1 })
