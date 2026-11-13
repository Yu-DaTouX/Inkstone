import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const dir = await mkdtemp(join(tmpdir(), 'inkstone-peer-retired-'))
let server
try {
  const bundle = async (entry, name) => {
    const outfile = join(dir, `${name}.mjs`)
    await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
    return import(pathToFileURL(outfile).href)
  }
  const { RemoteServer } = await bundle('src/main/remote-server.ts', 'server')
  const { RemoteDeviceStore } = await bundle('src/main/remote-devices.ts', 'devices')

  const store = new RemoteDeviceStore(dir)
  const legacyPairing = store.startPairing()
  const legacy = await store.pair(legacyPairing.code, '老电脑', 'peer')
  assert.ok(legacy.ok)
  assert.equal(legacy.device.kind, 'peer')

  const commands = []
  server = new RemoteServer({
    host: '127.0.0.1',
    port: 0,
    devices: store,
    handlers: {
      async snapshot() { return { sessions: [{ id: 's-a' }] } },
      async history(sessionId) { commands.push(['history', sessionId]); return { ok: true, data: {} } },
      async command(command) { commands.push(command); return { ok: true, data: command } }
    }
  })
  const info = await server.start()
  const call = async (method, path, token, body) => {
    const response = await fetch(`http://127.0.0.1:${info.port}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        'x-yan-idempotency-key': 'retired-check-0001'
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    return { status: response.status, body: await response.json().catch(() => ({})) }
  }

  const routes = [
    ['GET', '/remote/v1/status'], ['GET', '/remote/v1/sessions'], ['GET', '/remote/v1/events'], ['GET', '/remote/v1/sessions/s-a'],
    ['POST', '/remote/v1/sessions/s-a/messages', { text: 'hi' }], ['POST', '/remote/v1/runs/abort', { runId: 'r1' }],
    ['GET', '/remote/v1/peer/sessions'], ['POST', '/remote/v1/peer/connect', { operations: ['read'] }], ['GET', '/remote/v1/peer/events'],
    ['POST', '/remote/v1/peer/projects/p/sessions', { text: 'hi' }]
  ]
  for (const [method, path, body] of routes) {
    const result = await call(method, path, legacy.token, body)
    assert.equal(result.status, 403, `旧的另一台砚令牌 ${method} ${path}`)
    assert.equal(result.body.code, 'peer_scope', `旧的另一台砚令牌 ${method} ${path} 的错误码`)
  }
  assert.equal(commands.length, 0, '旧的另一台砚令牌没有到达任何处理器')

  const legacyInfo = await call('GET', '/remote/v1/info', legacy.token)
  assert.equal(legacyInfo.status, 200)
  assert.deepEqual(legacyInfo.body.capabilities, [], '旧的另一台砚只能看到空能力表')

  const before = (await store.list()).length
  const peerPairing = store.startPairing()
  const rejected = await call('POST', '/remote/v1/pair', null, { code: peerPairing.code, deviceName: '另一台', kind: 'peer' })
  assert.equal(rejected.status, 403, '新的另一台砚配对被拒绝')
  assert.equal(rejected.body.code, 'peer_retired')
  assert.equal((await store.list()).length, before, '被拒的配对不留设备记录')

  const phonePairing = store.startPairing()
  const paired = await call('POST', '/remote/v1/pair', null, { code: phonePairing.code, deviceName: '手机' })
  assert.equal(paired.status, 200, '手机仍能配对')
  assert.equal(paired.body.device.kind, 'phone')
  const sessions = await call('GET', '/remote/v1/sessions', paired.body.token)
  assert.equal(sessions.status, 200, '手机仍能读会话列表')
  const phonePeer = await call('GET', '/remote/v1/peer/sessions', paired.body.token)
  assert.equal(phonePeer.status, 404, '对端接口已不存在')

  const legacyDir = join(dir, 'legacy-devices')
  await mkdir(legacyDir, { recursive: true })
  await writeFile(join(legacyDir, 'remote-devices.json'), JSON.stringify({
    version: 1,
    devices: [
      { id: 'device-old-1', name: '砚 · 老电脑', kind: 'peer', createdAt: 1, lastSeenAt: null, revokedAt: null, tokenHash: 'a'.repeat(64) },
      { id: 'device-old-2', name: 'Inkstone · LAPTOP-X', kind: 'phone', createdAt: 1, lastSeenAt: null, revokedAt: null, tokenHash: 'b'.repeat(64) },
      { id: 'device-old-3', name: '别的名字', kind: 'phone', createdAt: 1, lastSeenAt: null, revokedAt: null, tokenHash: 'c'.repeat(64) }
    ]
  }), 'utf8')
  const listed = await new RemoteDeviceStore(legacyDir).list()
  assert.equal(listed.map((item) => item.name).join(','), '老电脑,LAPTOP-X,别的名字', '旧设备表照常读入')
  assert.equal(listed[0].kind, 'peer', '旧的另一台砚记录保留原类型，不会被当成手机')

  console.log('test-remote-peer-retired: PASS')
} finally {
  await server?.stop().catch(() => undefined)
  await rm(dir, { recursive: true, force: true })
}
