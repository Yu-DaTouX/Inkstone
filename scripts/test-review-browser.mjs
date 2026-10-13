import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { build } from '../node_modules/esbuild/lib/main.js'
import ts from 'typescript'
import vm from 'node:vm'
import { join } from 'node:path'

const entries = [
  ['src/main/chrome.ts', 'out/test/review-browser-chrome.mjs'],
  ['src/main/browser/RawCdp.ts', 'out/test/review-browser-raw-cdp.mjs'],
  ['src/main/browser/cookie-transfer.ts', 'out/test/review-browser-cookie-transfer.mjs'],
  ['src/main/browser/storage-transfer.ts', 'out/test/review-browser-storage-transfer.mjs']
]
for (const [entryPoint, outfile] of entries) {
  await build({ entryPoints: [entryPoint], outfile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' })
}

const { buildChromeArgs } = await import('../out/test/review-browser-chrome.mjs')
const args = buildChromeArgs({ profileDir: 'isolated-profile', port: 43871 })
assert(args.includes('--remote-debugging-port=43871'))
assert(args.includes('--remote-allow-origins=http://localhost,http://127.0.0.1'))
assert(!args.includes('--remote-allow-origins=*'))

const { transferCookies } = await import('../out/test/review-browser-cookie-transfer.mjs')
class CookieChannel {
  constructor(cookies = [], responses = []) { this.cookies = cookies; this.responses = responses }
  async send(method) {
    if (method === 'Network.getAllCookies') return { cookies: this.cookies }
    const next = this.responses.shift()
    if (next instanceof Error) throw next
    return next ?? {}
  }
}
const cookie = (name) => ({ name, value: 'v', domain: 'example.test', path: '/', secure: true, httpOnly: false, session: true, expires: 0 })
assert.deepEqual(await transferCookies(new CookieChannel([cookie('a'), cookie('b')]), new CookieChannel([], [{ success: false }, {}])), { copied: 1, failed: 1 })

const { transferPageStorage } = await import('../out/test/review-browser-storage-transfer.mjs')
const storageResult = (value, exceptionDetails) => ({ result: { value }, ...(exceptionDetails ? { exceptionDetails } : {}) })
const sourceFailure = { async send() { return storageResult(undefined, { text: 'SecurityError' }) } }
await assert.rejects(transferPageStorage(sourceFailure, {}, 'localStorage'), /SecurityError/)
const source = { async send() { return storageResult({ a: '1', b: '2' }) } }
const targetFailure = { async send() { return storageResult(undefined, { text: 'SecurityError' }) } }
assert.deepEqual(await transferPageStorage(source, targetFailure, 'sessionStorage'), { copied: 0, failed: 2, kind: 'sessionStorage' })

const browserSource = await readFile('src/main/browser.ts', 'utf8')
assert.match(browserSource, /mode: activeIsExternal \? 'external' : 'embedded'/)
assert.match(browserSource, /this\.external && this\.activeMode === 'external'\) return/)
assert.match(browserSource, /if \(this\.externalOpening\) return this\.externalOpening/)
const browserAst = ts.createSourceFile('browser.ts', browserSource, ts.ScriptTarget.Latest, true)
let downloadMethod
function visit(node) {
  if (ts.isMethodDeclaration(node) && node.name.getText(browserAst) === 'handleDownload') downloadMethod = node
  ts.forEachChild(node, visit)
}
visit(browserAst)
assert.ok(downloadMethod, 'handleDownload must exist')
const downloadCode = ts.transpileModule(`class DownloadFixture { ${downloadMethod.getText(browserAst)} }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText + '\nnew DownloadFixture()'

async function checkDownload(methodCode, failMkdir = false) {
  const order = []
  let savedPath
  const directory = join('fixture', 'downloads')
  const host = vm.runInNewContext(methodCode, {
    app: { getPath: (kind) => { assert.equal(kind, 'downloads'); return directory } },
    join, randomUUID: () => 'fixture-id',
    mkdirSync: (path, options) => {
      order.push('mkdir')
      assert.equal(path, directory)
      assert.equal(options.recursive, true)
      if (failMkdir) throw new Error('fixture mkdir failure')
    }
  })
  const item = {
    getFilename: () => 'bad<>:"/\\\\|?*\u0001.txt', getURL: () => 'https://fixture.test/download',
    setSavePath: (path) => { order.push('save'); savedPath = path },
    once: (event) => { assert.equal(event, 'done'); order.push('done') }
  }
  if (failMkdir) {
    await assert.rejects(host.handleDownload(item), /fixture mkdir failure/)
    assert.deepEqual(order, ['mkdir'], 'failed mkdir must not set a save path')
    assert.equal(savedPath, undefined)
  } else {
    await host.handleDownload(item)
    assert.deepEqual(order, ['mkdir', 'save', 'done'], 'directory must exist before setting the save path')
    assert.equal(savedPath, join(directory, 'fixture-id-bad___________.txt'))
  }
}
await checkDownload(downloadCode)
await checkDownload(downloadCode, true)
const legacyDownloadCode = ts.transpileModule(`class DownloadFixture { ${downloadMethod.getText(browserAst).replace('    mkdirSync(directory, { recursive: true })\n', '').replace('    item.setSavePath(path)', '    item.setSavePath(path)\n    mkdirSync(directory, { recursive: true })')} }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText + '\nnew DownloadFixture()'
await assert.rejects(checkDownload(legacyDownloadCode), /directory must exist/, 'negative control must reject the old order')
assert.match(browserSource, /handleDownload\(item, owner\)\.catch/)
assert.match(browserSource, /const cdp = new RawCdp\(target\.webSocketDebuggerUrl\)[\s\S]{0,180}await cdp\.attach\(\)[\s\S]{0,900}await previousCdp\.detach\(\)/)

const { RawCdp } = await import('../out/test/review-browser-raw-cdp.mjs')
class FakeWebSocket {
  static latest
  listeners = new Map()
  constructor() { FakeWebSocket.latest = this; queueMicrotask(() => this.emit('open', {})) }
  addEventListener(type, callback) { const list = this.listeners.get(type) ?? []; list.push(callback); this.listeners.set(type, list) }
  emit(type, event) { for (const callback of this.listeners.get(type) ?? []) callback(event) }
  send(data) {
    const request = JSON.parse(data)
    queueMicrotask(() => this.emit('message', { data: JSON.stringify({ id: request.id, result: {} }) }))
  }
  close() { this.emit('close', {}) }
}
globalThis.WebSocket = FakeWebSocket
const cdp = new RawCdp('ws://fixture')
await cdp.attach()
FakeWebSocket.latest.close()
await assert.rejects(cdp.send('Runtime.evaluate'), /关闭/)
console.log('review-browser: Chrome Origin、Cookie/Storage 失败统计、CDP close 即时拒绝均通过')
