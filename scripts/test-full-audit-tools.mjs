import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const output = resolve('.tmp/full-audit-fixes/tools')
mkdirSync(output, { recursive: true })
const results = []
function load(path, mocks = {}) {
  const source = readFileSync(path, 'utf8').replaceAll('import.meta.url', JSON.stringify(import.meta.url))
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports = {}
  vm.runInNewContext(code, { exports, require: (name) => name in mocks ? mocks[name] : require(name), Buffer, process, console, AbortController, setTimeout, clearTimeout }, { filename: path })
  return exports
}
async function test(name, run) {
  try { await run(); results.push({ name, ok: true }) }
  catch (error) { results.push({ name, ok: false, error: error.stack }) }
}
const protocol = load('integrations/inkstone-minecraft/mcp/protocol.ts')
const info = { name: 'fixture', version: '1', instructions: '' }
const noop = () => { throw new Error('unexpected dependency call') }
const mocks = Object.fromEntries([...readFileSync('integrations/inkstone-minecraft/mcp/tools.ts', 'utf8').matchAll(/from '([^']+)'/g)].filter((match) => !match[1].startsWith('node:')).map((match) => [match[1], new Proxy({}, { get: () => noop })]))
mocks['./protocol.ts'] = protocol
mocks['./tools-tick.ts'] = { tickResetReminder: async () => null }
mocks['../src/core/dev/runner.ts'] = { LAUNCH_ENV_KEYS: [] }
const { createTools } = load('integrations/inkstone-minecraft/mcp/tools.ts', mocks)
await test('mc_run rejects unknown and malformed actions without project side effects', async () => {
  let restarts = 0
  const project = { control: async () => ({ owner: 'user' }), restart: async () => { restarts++; throw new Error('unexpected restart reached while user controls game') } }
  let projects = 0
  const tool = createTools({ project: () => { projects++; return project }, options: { maxMemoryMb: 1024 } }).find((item) => item.name === 'mc_run')
  for (const action of ['typo', '__proto__', 'constructor', '', null, undefined, 42, [], {}]) {
    const result = await tool.run({ action })
    assert.equal(result.isError, true, JSON.stringify(action))
  }
  assert.equal(restarts, 0)
  assert.equal(projects, 0)
  for (const action of ['start', 'stop', 'restart']) assert.equal((await tool.run({ action })).isError, true)
})
await test('malformed JSON-RPC is rejected and stdio remains usable', async () => {
  for (const message of [null, [], 4, 'x', {}, { jsonrpc: '1.0', method: 'ping', id: 1 }, { jsonrpc: '2.0', method: 'ping', id: {} }]) {
    const response = await protocol.handleMessage(message, [], info)
    assert.equal(response.error.code, -32600)
  }
  let calls = 0
  const tools = [{ name: 'fixture', run: async () => { calls++; return protocol.text('ok') } }]
  for (const params of [null, [], 1, { name: 'fixture', arguments: [] }, { name: 'fixture', arguments: null }, { name: 'fixture', arguments: 'x' }]) {
    const response = await protocol.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params }, tools, info)
    assert.equal(response.error.code, -32602)
  }
  assert.equal(calls, 0)
  const input = new PassThrough()
  const out = new PassThrough()
  let text = ''
  out.on('data', (chunk) => { text += chunk })
  protocol.serveStdio([], info, input, out)
  input.write('null\n{\n{"jsonrpc":"2.0","id":9,"method":"ping"}\n')
  await new Promise((done) => setImmediate(done))
  const replies = text.trim().split('\n').map(JSON.parse)
  assert.equal(replies.length, 3)
  assert.equal(replies.find((reply) => reply.id === 9).result instanceof Object, true)
  const valid = await protocol.handleMessage({ jsonrpc: '2.0', method: 'tools/call', id: 'valid', params: { name: 'fixture', arguments: {} } }, tools, info)
  assert.equal(valid.result.content[0].text, 'ok')
  assert.equal(calls, 1)
  assert.equal(await protocol.handleMessage({ jsonrpc: '2.0', method: 'ping' }, [], info), null)
})
await test('stdio dispatch rejection returns internal error without unhandled rejection', async () => {
  const input = new PassThrough()
  const out = new PassThrough()
  let text = ''
  out.on('data', (chunk) => { text += chunk })
  const tools = [{ get name() { throw new Error('fixture dispatch failure') } }]
  protocol.serveStdio(tools, info, input, out)
  input.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n')
  await new Promise((done) => setImmediate(done))
  const replies = text.trim().split('\n').map(JSON.parse)
  assert.equal(replies.some((reply) => reply.error?.code === -32603), true)
  assert.equal(replies.some((reply) => reply.id === 2 && reply.result), true)
})
const { CapabilityServer, CapabilityCommandError } = load('src/main/capability-server.ts')
for (const fail of [false, true]) await test(`capability stop aborts and suppresses late ${fail ? 'failure' : 'success'} after restart`, async () => {
  const opsDir = resolve(output, `ops-${Date.now()}-${fail}`)
  let complete
  let entered
  const started = new Promise((done) => { entered = done })
  let signal
  const service = new CapabilityServer({ opsDir, onlyCommands: ['fixture'], handlers: { run: async (_command, _params, _ctx, received) => {
    signal = received
    entered()
    return await new Promise((done, reject) => { complete = () => fail ? reject(new CapabilityCommandError('fixture', 'late', { late: true })) : done({ summary: {}, data: { late: true } }) })
  } } })
  let request
  try {
    const first = await service.start({ sessionId: 'a', projectId: 'p' })
    request = fetch(first.url, { method: 'POST', headers: { authorization: `Bearer ${first.token}` }, body: JSON.stringify({ apiVersion: 1, command: 'fixture', sessionId: 'a', projectId: 'p' }) }).then((res) => res.text()).catch(() => null)
    await started
    service.stop()
    const aborted = signal.aborted
    await service.start({ sessionId: 'b', projectId: 'p' })
    complete()
    await request
    await new Promise((done) => setImmediate(done))
    assert.equal(aborted, true)
    assert.equal(service.recentOps(50).length, 0)
    assert.deepEqual(readdirSync(opsDir), [])
  } finally { complete?.(); service.stop(); await request }
})
await test('capability active generation still persists successful and failed operations', async () => {
  const opsDir = resolve(output, `active-${Date.now()}`)
  const service = new CapabilityServer({ opsDir, onlyCommands: ['fixture'], handlers: { run: async (_command, params) => {
    if (params.fail) throw new CapabilityCommandError('fixture', 'expected', { failed: true })
    return { summary: { kind: 'fixture' }, data: { success: true } }
  } } })
  try {
    const { url, token } = await service.start({ sessionId: 'a', projectId: 'p' })
    for (const fail of [false, true]) {
      const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ apiVersion: 1, command: 'fixture', sessionId: 'a', projectId: 'p', params: { fail } }) })
      const result = await response.json()
      assert.equal(result.ok, !fail)
      assert.deepEqual(JSON.parse(readFileSync(result.resultFile, 'utf8')), fail ? { failed: true } : { success: true })
    }
    assert.equal(service.recentOps(50).length, 2)
    assert.equal(service.pending.size, 0)
  } finally { service.stop() }
})
for (const code of ['ENOENT', 'EACCES', 'success']) await test(`android boot waits for ${code} and handles later error`, async () => {
  const child = new EventEmitter()
  let unrefs = 0
  child.unref = () => { unrefs++ }
  const cp = { ...require('node:child_process'), spawn: () => child }
  const { AndroidDeviceService } = load('src/main/android/android-devices.ts', { 'node:child_process': cp, './android-paths': { emulatorPath: () => 'fixture', emulatorEnv: () => ({}) } })
  let settled = false
  const boot = new AndroidDeviceService(() => {}).boot('fixture').then(() => { settled = true; return null }, (error) => { settled = true; return error })
  await Promise.resolve()
  const premature = settled
  if (code === 'success') child.emit('spawn')
  else child.emit('error', Object.assign(new Error(code), { code }))
  const error = await boot
  assert.equal(premature, false)
  assert.equal(error?.code ?? null, code === 'success' ? null : code)
  assert.equal(unrefs, code === 'success' ? 1 : 0)
  child.emit('error', new Error('late'))
})
const failed = results.filter((result) => !result.ok)
const report = JSON.stringify({ results, passed: results.length - failed.length, failed: failed.length }, null, 2)
writeFileSync(resolve(output, process.argv.includes('--baseline') ? 'baseline.json' : 'regression.json'), report)
console.log(report)
process.exitCode = failed.length ? 1 : 0
