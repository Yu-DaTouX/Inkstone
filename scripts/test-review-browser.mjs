import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { build } from '../node_modules/esbuild/lib/main.js'

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
assert.ok(browserSource.includes("const filename = (begun?.filename ?? `download-${Date.now()}`).replace(/[<>:\"/\\\\|?*\\x00-\\x1f]/g, '_')"))
assert.ok(browserSource.indexOf('item.setSavePath(path)') < browserSource.indexOf('await mkdir(directory', browserSource.indexOf('private async handleDownload')))
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
