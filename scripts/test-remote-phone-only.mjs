import './lib/test-isolate.mjs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { REMOTE_VERSION, VERSION_HEADERS, callPath } from './lib/remote-call.mjs'

const dir = await mkdtemp(join(tmpdir(), 'inkstone-phone-only-'))
let server
try {
  const bundle = async (entry, name) => {
    const outfile = join(dir, `${name}.mjs`)
    await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
    return import(pathToFileURL(outfile).href)
  }
  const { RemoteServer } = await bundle('src/main/remote-server.ts', 'server')
  const { RemoteDeviceStore } = await bundle('src/main/remote-devices.ts', 'devices')

  const hash = (token) => createHash('sha256').update(token, 'utf8').digest('hex')
  const peerToken = 'p'.repeat(43)
  const agentToken = 'a'.repeat(43)
  const phoneToken = 'f'.repeat(43)
  const storeDir = join(dir, 'store')
  await mkdir(storeDir, { recursive: true })
  await writeFile(join(storeDir, 'remote-devices.json'), JSON.stringify({
    version: 1,
    devices: [
      { id: 'device-old-peer', name: '老电脑', kind: 'peer', createdAt: 1, lastSeenAt: null, revokedAt: null, tokenHash: hash(peerToken) },
      { id: 'device-old-agent', name: '礁石', kind: 'agent', createdAt: 1, lastSeenAt: null, revokedAt: null, tokenHash: hash(agentToken) },
      { id: 'device-phone', name: '手机', createdAt: 1, lastSeenAt: null, revokedAt: null, tokenHash: hash(phoneToken) }
    ]
  }), 'utf8')
  const store = new RemoteDeviceStore(storeDir)
  const listed = await store.list()
  assert.deepEqual(listed.map((item) => item.name), ['手机'], '旧的另一台砚与礁石记录读入时丢弃，没写类型的按手机保留')

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
        ...VERSION_HEADERS,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    return { status: response.status, body: await response.json().catch(() => ({})) }
  }

  for (const token of [peerToken, agentToken]) {
    for (const action of ['info', 'status', 'sessions']) {
      assert.equal((await call('POST', callPath(action), token, {})).status, 401, `旧令牌 ${action}`)
    }
  }
  assert.equal(commands.length, 0, '旧令牌没有到达任何处理器')
  assert.equal((await call('POST', callPath('sessions'), phoneToken, {})).status, 200, '手机令牌照常可用')

  for (const kind of [undefined, 'peer', 'agent']) {
    const pairing = store.startPairing()
    const paired = await call('POST', '/remote/v1/pair', null, { code: pairing.code, deviceName: `新手机-${kind}`, ...(kind ? { kind } : {}) })
    assert.equal(paired.status, 200, `声明 ${kind} 也按手机配对`)
    assert.equal(paired.body.device.kind, 'phone')
  }

  const kotlin = await readFile('mobile/android/app/src/main/java/com/yudatoux/inkstone/RemoteLink.kt', 'utf8')
  assert.equal(Number(/const val REMOTE_API_VERSION = (\d+)/.exec(kotlin)?.[1]), Number(REMOTE_VERSION), '安卓后台提醒服务的协议版本与电脑一致')
  assert.ok(!/\.get\("\/remote\/v1\//.test(kotlin + await readFile('mobile/android/app/src/main/java/com/yudatoux/inkstone/QuestionAlertService.kt', 'utf8')), '安卓后台提醒服务走动作接口')
  console.log('test-remote-phone-only: PASS')
} finally {
  await server?.stop().catch(() => undefined)
  await rm(dir, { recursive: true, force: true })
}
