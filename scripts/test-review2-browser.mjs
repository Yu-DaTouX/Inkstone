import assert from 'node:assert/strict'
import { build } from '../node_modules/esbuild/lib/main.js'

const entries = [
  ['src/main/browser/Observer.ts', 'out/test/review2-observer.mjs'],
  ['src/main/browser/InputController.ts', 'out/test/review2-input.mjs'],
  ['src/main/browser/NetworkTracker.ts', 'out/test/review2-network.mjs'],
  ['src/main/chrome-profile.ts', 'out/test/review2-profile.mjs'],
  ['src/main/search/aggregate.ts', 'out/test/review2-aggregate.mjs'],
  ['src/main/browser-commands.ts', 'out/test/review2-commands.mjs']
]
for (const [entryPoint, outfile] of entries) {
  await build({ entryPoints: [entryPoint], outfile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' })
}
await build({ entryPoints: ['src/main/browser.ts'], outfile: 'out/test/review2-browser-syntax.mjs', format: 'esm', platform: 'node', logLevel: 'silent' })

const { Observer } = await import('../out/test/review2-observer.mjs')
let finishTree
const handlers = new Map()
const cdp = {
  on(method, callback) { handlers.set(method, callback); return () => handlers.delete(method) },
  async send(method) {
    if (method === 'Page.getFrameTree') return new Promise((resolve) => { finishTree = resolve })
    return {}
  }
}
const observer = new Observer(cdp, { refresh() {}, resolve() {} })
handlers.get('Target.attachedToTarget')({ sessionId: 's1', targetInfo: { type: 'iframe', targetId: 'frame' } })
for (let attempt = 0; !finishTree && attempt < 10; attempt++) await new Promise((resolve) => setImmediate(resolve))
assert.equal(typeof finishTree, 'function')
handlers.get('Target.detachedFromTarget')({ sessionId: 's1' })
finishTree({ frameTree: { frame: { id: 'frame' } } })
await new Promise((resolve) => setImmediate(resolve))
assert.equal(observer.frameTreesBySession.size, 0, 'detached iframe result must not return to the map')
observer.dispose()
assert.equal(handlers.size, 0, 'dispose removes CDP subscriptions')

const { InputController } = await import('../out/test/review2-input.mjs')
const calls = []
const input = new InputController({ async send(method, params) { calls.push({ method, params }); if (method === 'DOM.resolveNode') return { object: { objectId: 'obj' } }; if (method === 'Runtime.callFunctionOn') return { result: { value: { ok: true, value: 'x' } } }; return {} } })
await input.select({ backendNodeId: 4, ref: 'r', sessionId: 's' }, 'x')
assert(calls.some((call) => call.method === 'Runtime.releaseObject' && call.params.objectId === 'obj'))
await assert.rejects(input.press('F5'), /不支持的按键/)
await input.press('/')
assert(calls.some((call) => call.method === 'Input.dispatchKeyEvent' && call.params.code === 'Slash'))

const { NetworkTracker } = await import('../out/test/review2-network.mjs')
const networkHandlers = new Map()
const network = new NetworkTracker({ on(method, callback) { networkHandlers.set(method, callback); return () => {} }, async send() {} })
await network.start()
networkHandlers.get('Network.requestWillBeSent')({ requestId: '1', request: { url: 'https://example.test/reset/secret-token?code=x', method: 'GET' } })
assert.equal(network.snapshot().entries[0].url, 'https://example.test/')

const { pickProfileName } = await import('../out/test/review2-profile.mjs')
assert.equal(pickProfileName(['Profile 1', 'Profile 10', 'Profile 2'], {}, 'Profile 10'), 'Profile 10')
assert.equal(pickProfileName(['Profile 1', 'Profile 10', 'Profile 2']), 'Profile 10')

const { normalizeRow } = await import('../out/test/review2-aggregate.mjs')
assert.equal(normalizeRow('brave', { title: 'long', url: `https://x.test/${'a'.repeat(501)}` }), null)
assert.equal(normalizeRow('brave', { title: 'ok', url: 'https://x.test/a' }).url, 'https://x.test/a')

const { BrowserCommands } = await import('../out/test/review2-commands.mjs')
const commands = new BrowserCommands({ browserHostOrNull: () => null, capabilityOpts: () => undefined })
for (const invalid of [null, false, '   ', {}]) assert.throws(() => commands.browserNumber({ value: invalid }, 'value'))
assert.equal(commands.browserNumber({ value: '12.5' }, 'value'), 12.5)

console.log('review2-browser: Observer teardown race, object release/key mapping, URL redaction, profile selection, long URL rejection, numeric validation passed')
