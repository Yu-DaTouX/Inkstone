import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp } from 'node:fs/promises'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { request as httpRequest } from 'node:http'

const lan = Object.values(networkInterfaces()).flat().find((item) => item && item.family === 'IPv4' && !item.internal)?.address
if (!lan) {
  console.log('跳过：本机没有非回环 IPv4 地址，无法验证明文拒绝与直连加密通道')
  process.exit(0)
}

const root = await mkdtemp(join(tmpdir(), 'inkstone-remote-tunnel-'))
await build({
  stdin: { contents: `export { RemoteAccess } from './src/main/remote-access'`, resolveDir: process.cwd(), loader: 'ts' },
  outfile: join(root, 'desk.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
  plugins: [{ name: 'electron-stub', setup(b) { b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' })); b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'const app = { getPath: () => process.cwd(), getVersion: () => "0.0.0", isPackaged: false, on() {} }; module.exports = new Proxy({ app }, { get: (t, k) => (k in t ? t[k] : typeof k === "string" ? {} : undefined) })', loader: 'js' })) } }], banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" }
})
await build({
  stdin: { contents: `export * from './src/api/relay'; export { pair, pairViaRelay, secureConnection, RemoteClient, RemoteEventStream } from './src/api/client'; export { parsePairingLink } from './src/pairLink'`, resolveDir: join(process.cwd(), 'mobile'), loader: 'ts' },
  outfile: join(root, 'mobile.mjs'), bundle: true, platform: 'neutral', format: 'esm', mainFields: ['module', 'main'], logLevel: 'silent'
})
const D = await import(pathToFileURL(join(root, 'desk.mjs')))
const M = await import(pathToFileURL(join(root, 'mobile.mjs')))

const dataDir = await mkdtemp(join(tmpdir(), 'inkstone-remote-tunnel-data-'))
const handlers = {
  async snapshot() { return { sessions: [{ id: 's1', name: '会话一' }] } }, async history() { return { ok: true } }, async command() { return { ok: true } }
}
const access = new D.RemoteAccess(dataDir, handlers)
await access.apply({ enabled: true, bind: lan, port: 0 })
const status = await access.status()
assert.ok(status.running, status.error ?? 'not running')
const base = `http://${lan}:${status.port}`

let failures = 0
const check = async (name, fn) => { try { await fn(); console.log(`✔ ${name}`) } catch (error) { failures++; console.log(`✖ ${name}\n  ${error?.stack ?? error}`) } }
const plain = (path, init = {}) => fetch(`${base}${path}`, init).then(async (res) => ({ status: res.status, json: await res.json().catch(() => ({})) }))

try {
  let connection
  await check('配对二维码只带直连加密地址（没开中继时不带中继），手机经直连加密通道配对', async () => {
    await access.relayPair('phone')
    const link = (await access.status()).relay.pairing.link
    const parsed = M.parsePairingLink(link)
    assert.ok(parsed?.relay, link)
    assert.deepEqual(parsed.relay.direct, [`ws://${lan}:${status.port}/remote/v1/tunnel`])
    assert.equal(parsed.relay.join, undefined)
    connection = await M.pairViaRelay(parsed.relay, '测试手机')
    assert.equal(M.RelayTunnel.for(connection.relay).route, 'direct')
    const info = await new M.RemoteClient(connection).info()
    assert.ok(info.capabilities.includes('sessions'))
    const device = (await access.status()).devices.find((d) => d.id === connection.deviceId)
    assert.equal(device?.encrypted, true)
    assert.ok((await access.status()).relay.clients.some((c) => c.id === device.tunnelClientId), '设备记录关联到它的加密通道客户端')
  })

  await check('经加密通道配对的令牌，明文直连一律拒绝', async () => {
    const res = await plain('/remote/v1/info', { headers: { authorization: `Bearer ${connection.token}` } })
    assert.equal(res.status, 403)
    assert.equal(res.json.code, 'tunnel_required')
  })

  await check('事件流经直连加密通道到达', async () => {
    const got = []
    let open
    const opened = new Promise((r) => { open = r })
    const stream = new M.RemoteEventStream(connection, { onEvent: (e) => got.push(e), onResync: () => undefined, onUnauthorized: () => undefined, onState: (s) => { if (s === 'open') open() } })
    stream.start()
    await opened
    access.publish({ ch: 'notify', payload: { text: '直连加密的通知 ✅' } })
    await new Promise((r) => setTimeout(r, 300))
    stream.stop()
    assert.ok(got.some((e) => e.channel === 'notify'), JSON.stringify(got).slice(0, 200))
  })

  await check('旧版手机明文配对被拒并提示更新；另一台砚（peer）配对已停用', async () => {
    access.startPairing()
    const phone = await plain('/remote/v1/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: '000000', deviceName: '旧手机' }) })
    assert.equal(phone.status, 426)
    assert.equal(phone.json.code, 'tunnel_required')
    const peer = await plain('/remote/v1/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: '000000', deviceName: '另一台', kind: 'peer' }) })
    assert.equal(peer.status, 403)
    assert.equal(peer.json.code, 'peer_retired')
    access.cancelPairing()
  })

  await check('手输地址与配对码：先取电脑公钥，再经直连加密通道配对', async () => {
    const { code } = access.startPairing()
    let confirmed = null
    const manual = await M.pair(base, code, '手输手机', async (identity) => {
      confirmed = identity
      return true
    })
    assert.ok(confirmed?.fingerprint, '手输配对必须核对电脑身份')
    assert.equal(confirmed.fingerprint, await access.hostIdentity())
    assert.ok(manual.relay?.direct?.length)
    assert.match(manual.baseUrl, /^relay:\/\//)
    assert.ok((await new M.RemoteClient(manual).info()).capabilities.includes('sessions'))
  })

  await check('没有配对进行中时，拿不到加密通道邀请', async () => {
    const res = await plain('/remote/v1/tunnel/invite')
    assert.equal(res.status, 403)
  })

  await check('旧的明文直连配对自动迁移到加密通道，迁移后明文失效', async () => {
    const { code } = access.startPairing()
    const legacy = await access.devices.pair(code, '老手机', 'phone')
    assert.ok(legacy.ok)
    const old = { baseUrl: base, token: legacy.token, deviceId: legacy.device.id, computerName: '电脑', deviceName: '老手机' }
    assert.equal((await plain('/remote/v1/info', { headers: { authorization: `Bearer ${old.token}` } })).status, 200)
    assert.ok((await access.status()).devices.find((d) => d.id === old.deviceId && !d.encrypted))
    const secured = await M.secureConnection(old)
    assert.ok(secured?.relay?.direct?.length)
    assert.equal(secured.token, old.token)
    assert.ok((await new M.RemoteClient(secured).info()).capabilities.includes('sessions'))
    assert.equal((await plain('/remote/v1/info', { headers: { authorization: `Bearer ${old.token}` } })).status, 403)
    const migrated = (await access.status()).devices.find((d) => d.id === old.deviceId)
    assert.ok(migrated?.encrypted && migrated.tunnelClientId, '迁移后的设备标记为加密并关联通道客户端')
    assert.equal(await M.secureConnection(old), null)
  })

  await check('直连地址不通且没有中继时，很快报错而不是一直等', async () => {
    const config = { direct: ['ws://127.0.0.1:1/remote/v1/tunnel'], hostKey: connection.relay.hostKey, clientKey: M.newClientKey() }
    const started = Date.now()
    await assert.rejects(new M.RelayTunnel(config).connect())
    assert.ok(Date.now() - started < 4000)
  })

  await check('网页来源的 WebSocket 升级被拒，未知客户端不带配对码被拒', async () => {
    const foreign = await new Promise((resolve) => {
      const req = httpRequest({ host: lan, port: status.port, path: '/remote/v1/tunnel', headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', origin: 'http://evil.example' } })
      req.on('upgrade', () => resolve('upgraded'))
      req.on('response', (res) => resolve(`status ${res.statusCode}`))
      req.on('error', () => resolve('closed'))
      req.end()
    })
    assert.equal(foreign, 'closed')
    const stranger = new M.RelayTunnel({ direct: connection.relay.direct, hostKey: connection.relay.hostKey, clientKey: M.newClientKey() })
    await assert.rejects(stranger.connect(), (error) => error.denied === true)
  })
} finally {
  await access.stop()
}
if (failures) { console.log(`\n${failures} 项失败`); process.exit(1) }
console.log('\n直连加密通道检查全部通过。')
process.exit(0)
