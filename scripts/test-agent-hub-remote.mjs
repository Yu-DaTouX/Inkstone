import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

const root = await mkdtemp(join(tmpdir(), 'inkstone-hub-remote-'))
await build({ entryPoints: ['src/main/remote-server.ts'], outfile: join(root, 'remote.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
const { RemoteServer } = await import(pathToFileURL(join(root, 'remote.mjs')))
const token = randomUUID(), legacy = randomUUID(), peer = randomUUID()
let calls = 0
const snapshot = { tasks: [], approvals: [], resources: [], projects: [], adapters: [] }
const server = new RemoteServer({ host: '127.0.0.1', port: 0, token: legacy, devices: { async authenticate(value) { return value === token ? { id: 'test-phone', kind: 'mobile' } : value === peer ? { id: 'test-peer', kind: 'peer' } : null } }, handlers: {
  async snapshot() { return {} }, async history() { return { ok: true } }, async command() { return { ok: true } }, async hubSnapshot() { return snapshot }, hubAttention() { return [{ id: 'task:fixture:run:needs_review', taskId: 'fixture' }] }, async hubCommand(command, actor) { calls++; assert.equal(actor, 'phone:test-phone'); return { ok: true, data: { action: command.action } } }
} })
await server.start()
const url = `http://127.0.0.1:${server.info.port}/remote/v1/hub`
const get = (value) => fetch(url, { headers: { authorization: `Bearer ${value}` } })
try {
  assert.equal((await get('invalid')).status, 401)
  assert.equal((await get(legacy)).status, 403, 'legacy tokens must not grant full terminal control')
  assert.equal((await get(peer)).status, 403, 'peer grants must not grant phone Hub access')
  assert.deepEqual((await (await get(token)).json()).data, snapshot)
  const attention = (value) => fetch(`${url}/attention`, { headers: { authorization: `Bearer ${value}` } })
  assert.equal((await attention(legacy)).status, 403)
  assert.equal((await attention(peer)).status, 403)
  assert.deepEqual((await (await attention(token)).json()).data.items, [{ id: 'task:fixture:run:needs_review', taskId: 'fixture' }])
  const send = (key, action = 'cancel') => fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) }, body: JSON.stringify({ action, taskId: 'fixture' }) })
  assert.equal((await send()).status, 400)
  const responses = await Promise.all([send('hub-test-idempotency'), send('hub-test-idempotency')])
  assert.equal(responses[0].status, 200); assert.equal(responses[1].status, 200); assert.equal(calls, 1)
  assert.equal((await send('hub-test-recovery', 'recover-resource')).status, 400)
  assert.equal((await send('hub-test-shell', 'shell')).status, 400)
  console.log('Agent Hub loopback protocol checks passed: pairing identity, legacy/peer denial, shared snapshot, mandatory idempotency, concurrent duplicate suppression, desktop-only recovery and action whitelist.')
} finally { await server.stop() }
