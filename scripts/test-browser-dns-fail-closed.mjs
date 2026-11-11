import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import ts from 'typescript'
import { runNetworkPolicyTests } from './test-network-policy.mjs'
import { runNetworkBoundaryTests } from './test-network-boundary.mjs'

let checks = 0
const ok = (condition, message) => { assert.ok(condition, message); checks++ }
const bundle = await build({
  stdin: { contents: "export * from './src/main/browser/network-policy'; export * from './src/main/browser/network-boundary'", resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
  plugins: [{ name: 'dns-fixture', setup(b) {
    b.onResolve({ filter: /^node:dns\/promises$/ }, () => ({ path: 'dns', namespace: 'fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const lookup = (...args) => globalThis.__dnsFixture(...args)' }))
  } }]
})
const policy = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))
globalThis.__dnsFixture = async () => [{ address: '127.0.0.1', family: 4 }]
await runNetworkPolicyTests(ok, policy)
await runNetworkBoundaryTests(ok, policy)

for (const code of ['ENOTFOUND', 'ETIMEOUT']) {
  globalThis.__dnsFixture = async () => { throw Object.assign(new Error(code), { code }) }
  ok(await policy.resolvesToPrivateAddress('broken.test'), `${code}: default lookup denies unknown addresses`)
  ok(await new policy.PrivateDnsGuard().resolves('broken.test'), `${code}: browser guard denies unknown addresses`)
  ok(await policy.shouldBlockHiddenPageRequest('https://broken.test/'), `${code}: hidden-page default denies unknown addresses`)
  await assert.rejects(policy.resolvesToPrivateAddressStrict('broken.test'), { code })
  checks++
}
for (const addresses of [[], ['not-an-ip'], ['8.8.8.8', '127.0.0.1'], ['8.8.8.8', '192.168.1.1'], ['2001:4860:4860::8888', 'fd00::1']]) {
  globalThis.__dnsFixture = async () => addresses.map(address => ({ address, family: address.includes(':') ? 6 : 4 }))
  ok(await policy.resolvesToPrivateAddress('mixed.test'), `empty, invalid or mixed private answers are denied: ${addresses.join(',')}`)
}
globalThis.__dnsFixture = async () => [{ address: '8.8.8.8', family: 4 }, { address: '2001:4860:4860::8888', family: 6 }]
ok(!(await policy.resolvesToPrivateAddress('public.test')), 'confirmed public A/AAAA answers are allowed')
ok(await policy.resolvesToPrivateAddress(''), 'empty hostname is unknown, not public')
let finishDns
let lookups = 0
globalThis.__dnsFixture = () => { lookups++; return new Promise(resolve => { finishDns = resolve }) }
const guard = new policy.PrivateDnsGuard()
const started = Date.now()
const pending = guard.resolves('hung.test')
const shared = guard.resolves('HUNG.TEST.')
ok(await pending && await shared, 'hung DNS is denied within a bounded wait')
ok(Date.now() - started < 6000 && lookups === 1, 'DNS timeout and concurrent de-duplication hold')
finishDns([{ address: '8.8.8.8', family: 4 }])
await Promise.resolve()
ok(await guard.resolves('hung.test'), 'late DNS success cannot replace the cached denial')

const source = await readFile('src/main/browser.ts', 'utf8')
const ast = ts.createSourceFile('browser.ts', source, ts.ScriptTarget.Latest, true)
let callback
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast).endsWith('.webRequest.onBeforeRequest')) callback = node.arguments[0].getText(ast)
  ts.forEachChild(node, visit)
}
visit(ast)
assert.ok(callback, 'browser request boundary exists')
const js = ts.transpileModule(`const callback = ${callback}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
let ready = true
let resolveTarget = async () => false
const blocked = []
const host = {
  tabs: new Map([[1, { view: { webContents: { id: 1 } }, pendingMainFrameUrl: 'http://127.0.0.1/', committedUrl: 'https://public.test/' }]]),
  resolvesToPrivateTarget: (hostname) => resolveTarget(hostname),
  recordBlockedRequest: (...args) => blocked.push(args)
}
const listener = new Function('view', 'pinnedGuardStatus', 'decideRequestBoundary', `${js}; return callback`).call(host,
  { webContents: { session: {} } }, () => ({ status: ready ? 'ready' : 'failed' }), policy.decideRequestBoundary)
async function request(url, resourceType = 'xhr') {
  let calls = 0
  const result = await new Promise(resolve => listener({ url, resourceType, webContentsId: 1, frame: { url: 'https://public.test/' } }, (value) => { calls++; resolve(value) }))
  await Promise.resolve()
  ok(calls === 1, `${url}: request callback settles exactly once`)
  return result
}
resolveTarget = async () => { throw new Error('DNS unavailable') }
ok((await request('https://broken.test/')).cancel === true, 'embedded browser cancels DNS promise rejection')
resolveTarget = async () => true
ok((await request('https://private.test/')).cancel === true && blocked.length === 1, 'private DNS answer is denied and recorded')
resolveTarget = async () => false
ok(!(await request('https://public.test/')).cancel, 'confirmed public browser request remains allowed')
ok(!(await request('http://127.0.0.1/', 'mainFrame')).cancel, 'explicit local top-level navigation remains allowed')
ok((await request('http://127.0.0.1/', 'subFrame')).cancel === true, 'the same local address is denied for a remote subframe')
ready = false
ok((await request('https://public.test/')).cancel === true, 'connection guard unavailable remains fail-closed')
for (const url of ['about:blank', 'data:text/html,fixture', 'file:///fixture.html']) {
  ok(!(await request(url)).cancel, `${url}: non-network navigation does not enter DNS checks`)
}
delete globalThis.__dnsFixture
console.log(`browser-dns-fail-closed: ${checks} checks passed (DNS and Electron callbacks are fixtures)`)
