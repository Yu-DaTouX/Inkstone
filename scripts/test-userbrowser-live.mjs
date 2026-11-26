#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import http from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import WebSocket from 'ws'

const CJS_REQUIRE_BANNER = "import { createRequire as __inkstoneCreateRequire } from 'node:module'; const require = __inkstoneCreateRequire(import.meta.url);"

async function runHostSuite(url, run) {
  if (!process.argv[1] || pathToFileURL(resolve(process.argv[1])).href !== url) return
  let checks = 0
  const dirs = []
  const ok = (condition, label, detail = '') => {
    assert.ok(condition, detail ? `${label}: ${detail}` : label)
    checks++
    console.log(`  ✓ ${label}`)
  }
  const compile = async (entry, options = {}) => {
    const dir = await mkdtemp(resolve('node_modules/.inkstone-test-build-'))
    dirs.push(dir)
    const outfile = join(dir, 'module.mjs')
    const banner = { ...options.banner, js: `${CJS_REQUIRE_BANNER}${options.banner?.js ?? ''}` }
    await build({ ...(options.stdin ? {} : { entryPoints: [entry] }), outfile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent', ...options, banner })
    return import(pathToFileURL(outfile).href)
  }
  try {
    await run(ok, compile)
    assert.ok(checks > 0, '没有执行任何断言')
    console.log(`${checks}/${checks} 通过`)
  } finally {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  }
}

const ENTRY = [
  "export { BrowserCommands } from './src/main/browser-commands.ts'",
  "export { userBrowser } from './src/main/user-browser/service.ts'",
  "export * from './src/main/user-browser/native-host.ts'"
].join('\n')

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const FIREFOX = process.env.FIREFOX_PATH || resolve('.tmp/ext-bridge-exp/firefox/core/firefox.exe')
const ELECTRON = resolve('node_modules/electron/dist/electron.exe')
const EXTENSION = resolve('resources/browser-cookie-bridge')

const APP = `
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
const log = (entry) => navigator.sendBeacon('/log', JSON.stringify({ frame: location.host, ...entry }))
function App() {
  const [value, setValue] = useState('')
  return (
    <div style={{ font: '14px system-ui', padding: 16 }}>
      <button onClick={(e) => log({ t: 'click', target: 'main', isTrusted: e.nativeEvent.isTrusted })}>Trusted check</button>
      <input placeholder="react controlled" value={value} onChange={(e) => { setValue(e.target.value); log({ t: 'react', value: e.target.value }) }} />
      <div contentEditable suppressContentEditableWarning aria-label="rich editor" style={{ minHeight: 30, border: '1px solid #999' }} onInput={(e) => log({ t: 'editor', text: e.currentTarget.textContent })}></div>
      <select aria-label="color" onChange={(e) => log({ t: 'select', value: e.target.value })}><option value="red">Red</option><option value="green">Green</option></select>
      <form onSubmit={(e) => { e.preventDefault(); log({ t: 'submit', value: new FormData(e.currentTarget).get('q') }) }}><input name="q" placeholder="search box" /></form>
      <iframe src={'http://localhost:' + location.port + '/frame.html'} style={{ width: 400, height: 80 }}></iframe>
      <div style={{ height: 2000 }}>tall</div>
    </div>
  )
}
createRoot(document.getElementById('root')).render(<App />)
`

const FRAME = `<!doctype html><meta charset="utf-8"><button id="b">Frame button</button><input id="i" placeholder="frame input">
<script>
const log = (e) => navigator.sendBeacon('/log', JSON.stringify({ frame: location.host, ...e }))
b.addEventListener('click', (e) => log({ t: 'click', target: 'frame', isTrusted: e.isTrusted }))
i.addEventListener('input', () => log({ t: 'frame-input', value: i.value }))
</script>`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const freePort = () => new Promise((r) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
const reg = (args) => new Promise((r) => execFile('reg', args, { windowsHide: true }, (error, stdout) => r(error ? null : String(stdout))))

async function pageServer() {
  const bundle = await build({ stdin: { contents: APP, loader: 'jsx', resolveDir: resolve('.') }, bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' })
  const js = bundle.outputFiles[0].text
  const logs = []
  const server = http.createServer((req, res) => {
    if (req.url === '/log') {
      let body = ''
      req.on('data', (d) => (body += d)).on('end', () => { try { logs.push(JSON.parse(body)) } catch {} res.end() })
      return
    }
    if (req.url === '/app.js') { res.setHeader('content-type', 'text/javascript'); return res.end(js) }
    if (req.url === '/frame.html') { res.setHeader('content-type', 'text/html'); return res.end(FRAME) }
    res.setHeader('content-type', 'text/html')
    res.end('<!doctype html><meta charset="utf-8"><title>bridge live</title><div id="root"></div><script>new MutationObserver(() => { if (document.querySelector("[data-inkstone-agent-cursor]") && !window.__cursorSeen) { window.__cursorSeen = true; navigator.sendBeacon("/log", JSON.stringify({ t: "cursor" })) } }).observe(document.documentElement, { childList: true })</script><script src="/app.js"></script>')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { port: server.address().port, logs, close: () => { server.closeAllConnections?.(); server.close() } }
}

function launchChromium(exe, profile, extensionDir) {
  const proc = spawn(exe, [`--user-data-dir=${profile}`, '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check', '--headless=new', '--window-size=1000,800', 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } })
  let buffer = ''
  let seq = 0
  const pending = new Map()
  proc.stdio[4].on('data', (d) => {
    buffer += d
    let i
    while ((i = buffer.indexOf('\0')) >= 0) {
      const msg = JSON.parse(buffer.slice(0, i))
      buffer = buffer.slice(i + 1)
      const p = pending.get(msg.id)
      if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result) }
    }
  })
  const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { resolve: res, reject: rej }); proc.stdio[3].write(JSON.stringify({ id, method, params }) + '\0') })
  return { ready: send('Extensions.loadUnpacked', { path: extensionDir }), close: async () => { try { await send('Browser.close') } catch {} setTimeout(() => proc.kill(), 1000) } }
}

async function launchFirefox(profile) {
  const port = await freePort()
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'user.js'), ['user_pref("browser.shell.checkDefaultBrowser", false);', 'user_pref("datareporting.policy.dataSubmissionEnabled", false);', 'user_pref("app.update.disabledForTesting", true);'].join('\n'))
  const proc = spawn(FIREFOX, ['-headless', '-no-remote', '-profile', profile, `--remote-debugging-port=${port}`, 'about:blank'], { stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '', MOZ_CRASHREPORTER_DISABLE: '1' } })
  let bidi = null
  for (let i = 0; i < 60 && !bidi; i++) {
    bidi = await new Promise((r) => { const ws = new WebSocket(`ws://127.0.0.1:${port}/session`); ws.once('open', () => r(ws)); ws.once('error', () => r(null)) })
    if (!bidi) await sleep(500)
  }
  if (!bidi) throw new Error('firefox bidi unavailable')
  let seq = 0
  const pending = new Map()
  bidi.on('message', (d) => { const m = JSON.parse(String(d)); const p = pending.get(m.id); if (p) { pending.delete(m.id); m.type === 'error' ? p.reject(new Error(`${m.error}: ${m.message}`)) : p.resolve(m.result) } })
  const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { resolve: res, reject: rej }); bidi.send(JSON.stringify({ id, method, params })) })
  await send('session.new', { capabilities: {} })
  return { ready: send('webExtension.install', { extensionData: { type: 'path', path: EXTENSION } }), close: async () => { try { await send('session.end') } catch {} try { bidi.close() } catch {} setTimeout(() => proc.kill(), 1000) } }
}

await runHostSuite(import.meta.url, async (ok, compile) => {
  const mod = await compile(null, { stdin: { contents: ENTRY, resolveDir: resolve('.'), loader: 'ts' } })
  const dir = await mkdtemp(join(tmpdir(), 'inkstone-userbrowser-live-'))
  const previous = {}
  for (const [name, key] of Object.entries(mod.REGISTRY_KEYS)) previous[name] = await mod.windowsRegistry.read(key)
  const page = await pageServer()
  const server = mod.userBrowser.server
  try {
    const hostDir = join(dir, 'bridge')
    await mod.installBridgeHost({ dir: hostDir, hostSource: 'resources/browser-bridge-host/host.mjs', execPath: ELECTRON, register: true })
    await server.start(hostDir)
    ok(true, '注册临时宿主并启动桥接服务')

    const scenario = async (label, kind, launch, trusted) => {
      const before = server.connections().filter((c) => c.info.browser === kind).length
      const browser = await launch()
      try {
        await browser.ready
        for (let i = 0; i < 150 && server.connections().filter((c) => c.info.browser === kind).length <= before; i++) await sleep(100)
        const connection = server.connections().find((c) => c.info.browser === kind)
        ok(!!connection, `${label}：扩展经 native messaging 连上砚`)
        ok(connection.info.debugger === trusted, `${label}：调试权限状态为 ${trusted}`)
        const commands = new mod.BrowserCommands({
          browserHostOrNull: () => ({ getState: () => ({ open: false, url: '', title: '', loading: false, canGoBack: false, canGoForward: false, mode: 'embedded' }) }),
          capabilityOpts: () => ({ sessionId: label, runnerGeneration: 1, opsDir: dir }),
          conversationId: () => label,
          cwd: () => dir,
          confirmToolConsent: async () => ({ decision: 'allow' })
        })
        const run = (action, params = {}) => commands.runBrowserCommand(action, params)
        const connected = await run('connect-user', { browser: kind })
        ok(connected.summary.mode === 'user' && connected.summary.trustedInput === trusted, `${label}：connect-user 切到用户浏览器`)
        await run('navigate', { url: `http://127.0.0.1:${page.port}/` })
        await sleep(800)
        const seen = await run('observe', { all: true })
        const find = (name) => seen.data.elements.find((e) => e.name === name)?.ref
        const refs = { main: find('Trusted check'), react: find('react controlled'), editor: find('rich editor'), color: find('color'), search: find('search box'), fbtn: find('Frame button'), finput: find('frame input') }
        ok(Object.values(refs).every(Boolean), `${label}：observe 看到主页面与跨域 iframe 的元素`, JSON.stringify(refs))
        const start = page.logs.length
        await run('click', { ref: refs.main })
        await run('type', { ref: refs.react, text: 'hello 砚' })
        await run('type', { ref: refs.editor, text: 'rich 文本' })
        await run('select', { ref: refs.color, value: 'Green' })
        await run('click', { ref: refs.fbtn })
        await run('type', { ref: refs.finput, text: 'iframe ok' })
        await run('type', { ref: refs.search, text: 'q1' })
        await run('press', { key: 'Enter' })
        await sleep(500)
        const logs = page.logs.slice(start)
        const last = (t, pred = () => true) => [...logs].reverse().find((l) => l.t === t && pred(l))
        ok(last('click', (l) => l.target === 'main')?.isTrusted === trusted, `${label}：主页面点击送达（isTrusted=${trusted}）`)
        ok(last('react')?.value === 'hello 砚', `${label}：React 受控输入状态更新`)
        ok(last('editor')?.text === 'rich 文本', `${label}：富文本输入`)
        ok(last('select')?.value === 'green', `${label}：下拉框按可见文案选值`)
        ok(last('click', (l) => l.target === 'frame')?.isTrusted === trusted, `${label}：跨域 iframe 点击送达`)
        ok(last('frame-input')?.value === 'iframe ok', `${label}：跨域 iframe 输入`)
        ok(last('submit')?.value === 'q1', `${label}：Enter 提交表单`)
        ok(!!last('cursor'), `${label}：页面上画出代理光标`)
        const shot = await run('screenshot')
        ok(shot.summary.bytes > 1000 && existsSync(shot.summary.savedTo), `${label}：截图`)
        await cp(shot.summary.savedTo, join(dir, `${label}.png`))
        const scrolled = await run('scroll', { 'delta-y': 600 })
        ok(scrolled.summary.scroll?.y > 0, `${label}：滚动并回报位置`)
        const text = await run('text', { find: 'tall' })
        ok(text.summary.count >= 1, `${label}：读取正文`)
        const closed = await run('close-tab')
        ok(closed.data.tabs.length === 0, `${label}：关闭砚自己开的标签`)
        await run('disconnect-user')
      } finally {
        await browser.close()
      }
    }

    if (existsSync(CHROME)) {
      await scenario('chrome', 'chrome', () => launchChromium(CHROME, join(dir, 'chrome'), EXTENSION), false)
      const trustedExt = join(dir, 'ext-trusted')
      await cp(EXTENSION, trustedExt, { recursive: true })
      const manifest = JSON.parse(await readFile(join(trustedExt, 'manifest.json'), 'utf8'))
      manifest.permissions.push('debugger')
      delete manifest.optional_permissions
      await writeFile(join(trustedExt, 'manifest.json'), JSON.stringify(manifest))
      await scenario('chrome-trusted', 'chrome', () => launchChromium(CHROME, join(dir, 'chrome-trusted'), trustedExt), true)
    }
    if (existsSync(EDGE)) await scenario('edge', 'edge', () => launchChromium(EDGE, join(dir, 'edge'), EXTENSION), false)
    if (existsSync(FIREFOX)) await scenario('firefox', 'firefox', () => launchFirefox(join(dir, 'firefox')), false)
    if (process.env.KEEP_SHOTS) {
      await mkdir(process.env.KEEP_SHOTS, { recursive: true })
      for (const label of ['chrome', 'chrome-trusted', 'edge', 'firefox']) if (existsSync(join(dir, `${label}.png`))) await cp(join(dir, `${label}.png`), join(process.env.KEEP_SHOTS, `${label}.png`))
    }
  } finally {
    await server.stop()
    page.close()
    for (const [name, key] of Object.entries(mod.REGISTRY_KEYS)) {
      if (previous[name]) await mod.windowsRegistry.write(key, previous[name])
      else await reg(['delete', key, '/f'])
    }
    await sleep(1500)
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }).catch(() => undefined)
  }
})
