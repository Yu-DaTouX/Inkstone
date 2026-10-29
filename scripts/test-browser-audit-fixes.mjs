import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import ts from 'typescript'

const base = resolve('.tmp/full-audit-fixes/browser')
await mkdir(base, { recursive: true })
const dir = await mkdtemp(join(base, 'regression-'))
const outfile = join(dir, 'helpers.mjs')
await build({
  stdin: { contents: "export * from './src/main/browser/local-file-server'; export * from './src/main/browser/script-runner'", resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'error'
})
await build({ entryPoints: ['src/main/browser.ts'], bundle: true, external: ['*'], platform: 'node', format: 'cjs', outfile: join(dir, 'browser-syntax.cjs'), logLevel: 'error' })
const { serveLocalFile, runBrowserScript, ScriptError } = await import(pathToFileURL(outfile).href)
const source = await readFile('src/main/browser.ts', 'utf8')
const ast = ts.createSourceFile('browser.ts', source, ts.ScriptTarget.Latest, true)
const methods = new Map()
for (const node of ast.statements) {
  if (!ts.isClassDeclaration(node)) continue
  for (const member of node.members) {
    if (ts.isMethodDeclaration(member)) methods.set(member.name.getText(ast), member.getText(ast))
  }
}
const selected = ['openExternalChromeImpl', 'enableExternalBoundary', 'navigateExternal', 'handleExternalRequest', 'attachExternalTarget', 'runScript']
const js = ts.transpileModule(`class BrowserHarness { ${selected.map(name => methods.get(name)).join('\n')} }`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
let passed = 0
const failures = []
async function check(name, fn) {
  try { await fn(); passed++; console.log(`PASS ${name}`) }
  catch (error) { failures.push({ name, error: String(error.stack ?? error) }); console.error(`FAIL ${name}: ${error.message}`) }
}
function harness({ fetchFails = false, dnsFails = false, fetchGate } = {}) {
  const calls = []
  const channels = []
  class RawCdp {
    constructor() { this.listeners = new Map(); channels.push(this) }
    async attach() { calls.push('attach') }
    async detach() { calls.push('detach') }
    on(name, fn) { this.listeners.set(name, fn); calls.push(`on:${name}`); return () => this.listeners.delete(name) }
    async send(name, params) {
      calls.push([name, params])
      if (name === 'Fetch.enable' && fetchFails) throw new Error('fetch unavailable')
      if (name === 'Fetch.enable' && fetchGate) await fetchGate
      return {}
    }
  }
  class Stub { async start() {} dispose() {} }
  const chrome = { once() {} }
  const deps = {
    safeUrl: value => value, INITIAL_URL: 'about:blank', pickFreePort: async () => 1234,
    defaultProfileDir: () => join(dir, 'profile'), YAN_DIR: dir, mkdir,
    launchChrome: opts => { calls.push(['launch', opts]); return chrome },
    waitForCdp: async () => {}, listTargets: async () => [{ id: 'p1', url: 'about:blank', title: '', webSocketDebuggerUrl: 'ws://fake' }],
    pickPageTarget: targets => targets[0], RawCdp, ElementRegistry: Stub, Observer: Stub, InputController: Stub, NetworkTracker: Stub,
    stopChrome: value => calls.push(['stop', value]), runBrowserScript, ScriptError,
    decideExternalRequest: () => 'check-dns'
  }
  const BrowserHarness = new Function(...Object.keys(deps), `${js}; return BrowserHarness`)(...Object.values(deps))
  const host = new BrowserHarness()
  Object.assign(host, {
    external: null, externalBoundaryCdp: null, externalPendingUrl: '', activeMode: 'embedded', userControl: false,
    activeTab: () => null, profileSyncReport: async () => undefined, setupExternalDownloads: async () => {},
    syncExternalTabs: async () => {}, syncExternalHistory: async () => {}, hideOwnedViews() {}, updateState() {},
    pushError: message => calls.push(['error', message]), recordBlockedRequest() {},
    privateDns: { resolves: async () => { if (dnsFails) throw new Error('dns unavailable'); return false } }
  })
  return { host, calls, channels, RawCdp }
}

const root = join(dir, 'root')
const outside = join(dir, 'outside')
await mkdir(root)
await mkdir(outside)
await writeFile(join(root, 'entry.html'), '<html>local</html>')
await writeFile(join(root, 'ok.txt'), 'allowed')
await writeFile(join(outside, 'note.txt'), 'outside secret fixture')
await writeFile(join(outside, 'index.html'), 'outside index fixture')
await symlink(outside, join(root, 'link'), 'junction')
await mkdir(join(root, 'indexed'))
let fileLinkError
try { await symlink(join(outside, 'index.html'), join(root, 'indexed', 'index.html'), 'file') }
catch (error) { fileLinkError = error }
const entryUrl = await serveLocalFile(join(root, 'entry.html'), root)
async function request(path, method = 'GET') {
  const response = await fetch(new URL(path, entryUrl), { method, headers: { 'sec-fetch-dest': 'document' } })
  return { status: response.status, body: await response.text() }
}
await check('HTTP normal asset', async () => assert.deepEqual(await request('ok.txt'), { status: 200, body: 'allowed' }))
await check('HTTP junction outside file denied', async () => assert.equal((await request('link/note.txt')).status, 403))
await check('HTTP junction directory index denied', async () => assert.equal((await request('link/')).status, 403))
await check('HTTP index.html symlink denied', async () => {
  if (fileLinkError) throw new Error(`file symlink unavailable: ${fileLinkError.message}`)
  assert.equal((await request('indexed/')).status, 403)
})
await check('HTTP HEAD outside denied', async () => assert.equal((await request('link/note.txt', 'HEAD')).status, 403))
await check('HTTP root junction resolves normally', async () => {
  const alias = join(dir, 'root-alias')
  await symlink(root, alias, 'junction')
  const url = await serveLocalFile(join(alias, 'entry.html'), alias)
  assert.equal((await fetch(url, { headers: { 'sec-fetch-dest': 'document' } })).status, 200)
})
await check('HTTP in-root symlink and normal directory index remain available', async () => {
  await mkdir(join(root, 'normal'))
  await writeFile(join(root, 'normal', 'index.html'), '<html>normal index</html>')
  await symlink(join(root, 'ok.txt'), join(root, 'alias.txt'), 'file')
  assert.equal((await request('normal/')).status, 200)
  assert.deepEqual(await request('alias.txt'), { status: 200, body: 'allowed' })
})
await check('Chrome blank launch then guard then target navigation', async () => {
  const { host, calls } = harness()
  assert.equal((await host.openExternalChromeImpl('https://example.com/')).ok, true)
  assert.equal(calls.find(c => c[0] === 'launch')[1].url, 'about:blank')
  const guard = calls.findIndex(c => c[0] === 'Fetch.enable')
  const nav = calls.findIndex(c => c[0] === 'Page.navigate')
  assert.ok(guard >= 0 && nav > guard)
  assert.equal(calls[nav][1].url, 'https://example.com/')
})
await check('Chrome waits for guard acknowledgement before navigation', async () => {
  let release
  const fetchGate = new Promise(resolve => { release = resolve })
  const { host, calls } = harness({ fetchGate })
  const opening = host.openExternalChromeImpl('https://example.com/')
  try {
    const deadline = Date.now() + 2000
    while (!calls.some(c => c[0] === 'Fetch.enable') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(calls.some(c => c[0] === 'Fetch.enable'))
    assert.ok(calls.some(c => c === 'on:Fetch.requestPaused'))
    assert.ok(!calls.some(c => c[0] === 'Page.navigate'))
  } finally { release() }
  assert.equal((await opening).ok, true)
  assert.ok(calls.some(c => c[0] === 'Page.navigate'))
})
await check('Chrome guard failure closes process and never navigates', async () => {
  const { host, calls, channels } = harness({ fetchFails: true })
  const result = await host.openExternalChromeImpl('https://example.com/')
  assert.equal(result.ok, false)
  assert.match(result.error, /fetch unavailable/)
  assert.ok(calls.some(c => c[0] === 'stop'))
  assert.ok(calls.includes('detach'))
  assert.ok(!calls.some(c => c[0] === 'Page.navigate'))
  assert.equal(host.external, null)
  assert.notEqual(host.externalBoundaryCdp, channels[0])
})
await check('Chrome guard failure can retry same channel', async () => {
  const { host, calls, RawCdp } = harness({ fetchFails: true })
  const channel = new RawCdp()
  await assert.rejects(host.enableExternalBoundary(channel))
  await assert.rejects(host.enableExternalBoundary(channel))
  assert.equal(calls.filter(c => c[0] === 'Fetch.enable').length, 2)
  assert.equal(channel.listeners.size, 0)
})
await check('Chrome target switch guard failure keeps old target', async () => {
  const { host, calls } = harness({ fetchFails: true })
  const previous = { cdp: {}, observer: { dispose() { throw new Error('old observer disposed') } }, url: 'https://old.example/' }
  const oldCdp = previous.cdp
  host.external = previous
  await assert.rejects(host.attachExternalTarget({ id: 'next', url: 'about:blank', title: '', webSocketDebuggerUrl: 'ws://next' }))
  assert.equal(host.external.cdp, oldCdp)
  assert.equal(host.external.url, 'https://old.example/')
  assert.ok(calls.includes('detach'))
})
await check('Chrome DNS error fails closed', async () => {
  const { host, calls, RawCdp } = harness({ dnsFails: true })
  await host.handleExternalRequest(new RawCdp(), { requestId: 'r1', request: { url: 'https://unknown.example/' }, resourceType: 'Script' })
  assert.ok(calls.some(c => c[0] === 'Fetch.failRequest'))
  assert.ok(!calls.some(c => c[0] === 'Fetch.continueRequest'))
})
const actions = [
  ['goto', "page.goto('https://example.com')", 'navigate'],
  ['back', 'page.back()', 'back'], ['forward', 'page.forward()', 'forward'], ['reload', 'page.reload()', 'reload'],
  ['newPage', "task.newPage('https://example.com')", 'newTab'], ['switchTo', "task.switchTo('t1')", 'switchTab'], ['closePage', "task.closePage('t1')", 'closeTab'],
  ['click', "page.click('e1')", 'click'], ['fill', "page.fill('e1', 'text')", 'type'], ['select', "page.select('e1', 'v')", 'select'],
  ['press', "page.press('Enter')", 'press'], ['scroll', 'page.scroll(100)', 'scroll']
]
function scriptHost() {
  const { host } = harness()
  const calls = []
  const state = { url: 'about:blank', title: '', activeTabId: 't1', tabs: [] }
  host.getState = () => state
  host.observe = async () => ({ ...state, text: 'ok', elements: [] })
  for (const [, , method] of actions) host[method] = async () => { calls.push(method); return { ok: true } }
  return { host, calls }
}
for (const [name, action] of actions) {
  await check(`script ${name} rechecks takeover after sleep`, async () => {
    const { host, calls } = scriptHost()
    const running = host.runScript(`console.log('started'); await sleep(30); await ${action}`)
    host.userControl = true
    await assert.rejects(running, error => error.code === 'USER_CONTROL_ACTIVE')
    assert.deepEqual(calls, [])
  })
}
await check('script all actions allowed before takeover and after return', async () => {
  const { host, calls } = scriptHost()
  await host.runScript(actions.map(([, action]) => `await ${action}`).join(';'))
  assert.equal(calls.length, actions.length)
  host.userControl = true
  host.userControl = false
  await host.runScript("await page.goto('https://example.com')")
  assert.equal(calls.length, actions.length + 1)
})
await check('script read-only state remains available during takeover', async () => {
  const { host, calls } = scriptHost()
  host.userControl = true
  const result = await host.runScript('return { url: page.url(), pages: task.pages() }')
  assert.equal(result.result.url, 'about:blank')
  assert.deepEqual(calls, [])
})
await check('script caught denial cannot bypass next action', async () => {
  const { host, calls } = scriptHost()
  host.userControl = true
  const result = await host.runScript("const errors = []; try { await page.goto('https://example.com') } catch(e) { errors.push(e.code) }; try { await task.closePage() } catch(e) { errors.push(e.code) }; return errors")
  assert.deepEqual(result.result, ['USER_CONTROL_ACTIVE', 'USER_CONTROL_ACTIVE'])
  assert.deepEqual(calls, [])
})
await check('script timeout still prevents later mutation', async () => {
  const { host, calls } = scriptHost()
  await assert.rejects(runBrowserScript("await sleep(30); await page.goto('https://example.com')", { navigate: host.navigate, state: host.getState }, { timeoutMs: 5 }), error => error.code === 'script_timeout')
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.deepEqual(calls, [])
})
await check('script cancellation still prevents later mutation', async () => {
  const { host, calls } = scriptHost()
  const controller = new AbortController()
  const running = host.runScript("await sleep(30); await task.closePage()", controller.signal)
  controller.abort()
  await assert.rejects(running, error => error.code === 'script_aborted')
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.deepEqual(calls, [])
})
const summary = { passed, failed: failures.length, failures, artifacts: dir }
await writeFile(join(dir, 'result.json'), JSON.stringify(summary, null, 2))
console.log(JSON.stringify(summary, null, 2))
if (failures.length) process.exitCode = 1
