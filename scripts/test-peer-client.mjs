import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir, hostname } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { WebSocketServer } from 'ws'

const root = await mkdtemp(join(tmpdir(), 'inkstone-peer-client-'))

const electronStub = {
  name: 'electron-stub',
  setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-stub' }))
    build.onLoad({ filter: /.*/, namespace: 'electron-stub' }, () => ({
      contents: 'export const safeStorage = { isEncryptionAvailable: () => false, encryptString: (s) => Buffer.from(String(s)), decryptString: (b) => Buffer.from(b).toString() }\nexport default {}',
      loader: 'js'
    }))
  }
}

const buildClient = async (name, dataDir) => {
  const outfile = join(root, `${name}.mjs`)
  await build({
    entryPoints: ['src/main/peer-client.ts'],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
    plugins: [electronStub],
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" }
  })
  process.env.YAN_DATA_DIR = dataDir
  return import(pathToFileURL(outfile).href)
}

const tunnelModules = await build({
  stdin: { contents: `export { TunnelSession } from './src/main/relay-bridge/tunnel'; export { generateKeyPair, exportKeyPair, toB64u } from './src/main/relay-bridge/crypto'`, resolveDir: process.cwd(), loader: 'ts' },
  outfile: join(root, 'tunnel.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent'
}).then(() => import(pathToFileURL(join(root, 'tunnel.mjs')).href))

const clientKeys = async () => {
  const pair = await tunnelModules.generateKeyPair()
  return `raw:${JSON.stringify({ publicKey: tunnelModules.toB64u(pair.raw), privateJwk: await tunnelModules.exportKeyPair(pair) })}`
}

async function servePeer(httpHandler) {
  const http = createServer(httpHandler)
  const wss = new WebSocketServer({ server: http })
  const hostPair = await tunnelModules.generateKeyPair()
  wss.on('connection', (ws) => {
    const pipe = {
      send(text) {
        if (ws.readyState === ws.OPEN) ws.send(text)
      },
      close(code, reason) {
        ws.close(code ?? 1000, reason)
      }
    }
    new tunnelModules.TunnelSession(pipe, {
      hostKey: hostPair,
      authenticate: async (clientKey, name) => ({
        ok: true,
        client: { id: 'relay-test', key: clientKey, name, kind: 'peer', addedAt: 1, lastSeenAt: 1, revokedAt: null, pairedAt: 1, pendingUntil: null, online: true }
      }),
      target: () => ({ host: '127.0.0.1', port: http.address().port, relayToken: '' })
    })
    ws.on('message', (data) => pipe.onmessage?.(String(data)))
    ws.on('close', () => pipe.onclose?.())
  })
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve))
  const port = http.address().port
  return {
    port,
    address: `http://127.0.0.1:${port}`,
    hostKey: tunnelModules.toB64u(hostPair.raw),
    dropClients() {
      for (const ws of wss.clients) ws.terminate()
    },
    async close() {
      for (const ws of wss.clients) ws.terminate()
      await new Promise((resolve) => wss.close(resolve))
      await new Promise((resolve) => http.close(resolve))
    }
  }
}

const readBody = (req) => new Promise((resolve) => {
  let text = ''
  req.on('data', (chunk) => { text += chunk })
  req.on('end', () => resolve(text))
})
const json = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}
const invite = (endpoint, res) => json(res, 200, { ok: true, hostKey: endpoint.hostKey, code: 'relay-code', computer: { name: 'HOST-PC' } })

try {
  const retryDir = join(root, 'retry')
  await mkdir(retryDir, { recursive: true })
  const seen = []
  let attempts = 0
  let retryEndpoint = null
  retryEndpoint = await servePeer((req, res) => {
    attempts += 1
    seen.push({ key: req.headers['idempotency-key'], path: req.url })
    if (attempts === 1) {
      retryEndpoint.dropClients()
      return
    }
    json(res, 200, { ok: true, data: { accepted: true } })
  })
  await writeFile(join(retryDir, 'peers.json'), JSON.stringify({
    version: 1,
    peers: [{ id: 'peer-1', computer: '另一台砚', address: retryEndpoint.address, pairedAt: 1, deviceId: 'dev-1', token: 'raw:peer-token-0123456789', hostKey: retryEndpoint.hostKey, keys: await clientKeys() }]
  }), 'utf8')

  const { PeerClient } = await buildClient('peer-client-retry', retryDir)
  const client = new PeerClient()
  const sent = await client.send('peer-1', 's-1', '你好')
  assert.equal(sent.ok, true, `传输失败后按同一幂等键重试一次并成功：${sent.error ?? ''} / attempts=${attempts}`)
  assert.equal(attempts, 2, '只重试一次')
  assert.equal(seen[0].key, seen[1].key, '重试沿用同一个幂等键')
  assert.ok(typeof seen[0].key === 'string' && seen[0].key.startsWith('peer-'), '幂等键仍由对端客户端生成')
  assert.equal(seen[1].path, '/remote/v1/peer/sessions/s-1/messages')
  client.closeAll()
  await retryEndpoint.close()

  const corruptDir = join(root, 'corrupt')
  await mkdir(corruptDir, { recursive: true })
  await writeFile(join(corruptDir, 'peers.json'), '{ 这不是 JSON', 'utf8')
  const { PeerClient: CorruptClient } = await buildClient('peer-client-corrupt', corruptDir)
  const status = await new CorruptClient().status()
  assert.deepEqual(status.peers, [], '损坏的 peers.json 读到空列表而不是抛错')
  const backups = (await readdir(corruptDir)).filter((name) => name.endsWith('.corrupt'))
  assert.equal(backups.length, 1, '损坏的 peers.json 先留一份 .corrupt 备份')

  const grant = { connectionId: 'conn-1', deviceId: 'dev-1', deviceName: '另一台砚', projects: [], operations: ['read'], grantedAt: 1, activatedAt: null }
  let streamAttempts = 0
  const notices = []
  let peerEndpoint = null
  peerEndpoint = await servePeer(async (req, res) => {
    if (req.url === '/remote/v1/peer/disconnect' || req.url === '/remote/v1/devices/self/revoke') {
      notices.push({ path: req.url, method: req.method, body: await readBody(req) })
      json(res, 200, { ok: true })
      return
    }
    if (req.url === '/remote/v1/peer/connect') {
      json(res, 200, { ok: true, data: { grant } })
      return
    }
    if (req.url === '/remote/v1/peer/events') {
      streamAttempts += 1
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`event: grant\ndata: ${JSON.stringify(grant)}\n\n`)
      res.end()
      return
    }
    json(res, 404, { ok: false, error: 'not found' })
  })
  const reconnectDir = join(root, 'reconnect')
  await mkdir(reconnectDir, { recursive: true })
  await writeFile(join(reconnectDir, 'peers.json'), JSON.stringify({
    version: 1,
    peers: [{ id: 'peer-1', computer: '另一台砚', address: peerEndpoint.address, pairedAt: 1, deviceId: 'dev-1', token: 'raw:peer-token-0123456789', hostKey: peerEndpoint.hostKey, keys: await clientKeys() }]
  }), 'utf8')
  const { PeerClient: ReconnectClient } = await buildClient('peer-client-reconnect', reconnectDir)
  const reconnect = new ReconnectClient()
  const connected = await reconnect.connect('peer-1', ['read'], '看一下')
  assert.equal(connected.ok, true, connected.error)
  assert.equal(streamAttempts, 1)
  await new Promise((resolve) => setTimeout(resolve, 3500))
  assert.ok(streamAttempts >= 2, '事件流断开后自动重连一次，不直接置失败')
  reconnect.disconnect('peer-1')
  const beforeDisconnect = streamAttempts
  await new Promise((resolve) => setTimeout(resolve, 3500))
  assert.equal(streamAttempts, beforeDisconnect, '主动断开后不再重连')
  assert.equal(notices.filter((item) => item.path === '/remote/v1/peer/disconnect').length, 0, '内部断开（连接前、重连前）不发通知')

  const reconnected = await reconnect.connect('peer-1', ['read'], '再看一下')
  assert.equal(reconnected.ok, true, reconnected.error)
  await reconnect.endConnection('peer-1')
  const ended = notices.find((item) => item.path === '/remote/v1/peer/disconnect')
  assert.ok(ended, '用户点「断开」时通知对端')
  assert.equal(ended.method, 'POST')
  assert.deepEqual(JSON.parse(ended.body), { connectionId: 'conn-1' })
  const afterEnd = (await reconnect.status()).peers.find((item) => item.id === 'peer-1')
  assert.equal(afterEnd.connection.state, 'idle', '本地连接照旧断开')

  const removed = await reconnect.remove('peer-1')
  assert.equal(removed, true)
  assert.ok(notices.some((item) => item.path === '/remote/v1/devices/self/revoke'), '移除配对时通知对端撤销这台设备')
  assert.deepEqual((await reconnect.status()).peers, [], '本地配对已删除')
  await peerEndpoint.close()

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  for (const [index, item] of [
    { code: 'peer_connection_required', label: '授权被撤销' },
    { code: 'unauthorized', label: '设备被撤销' }
  ].entries()) {
    const endedGrant = { connectionId: `conn-ended-${index}`, deviceId: `dev-ended-${index}`, deviceName: '对端电脑', projects: [], operations: ['read'], grantedAt: 1, activatedAt: 1 }
    const pairBodies = []
    let endedStreamAttempts = 0
    let endedEndpoint = null
    endedEndpoint = await servePeer(async (req, res) => {
      if (req.url === '/remote/v1/tunnel/invite') {
        invite(endedEndpoint, res)
        return
      }
      if (req.url === '/remote/v1/pair') {
        pairBodies.push(JSON.parse((await readBody(req)) || '{}'))
        json(res, 200, { ok: true, deviceId: `dev-ended-${index}`, token: `fresh-token-${index}`, computer: { name: 'HOST-PC' } })
        return
      }
      if (req.url === '/remote/v1/peer/connect') {
        json(res, 200, { ok: true, data: { grant: endedGrant } })
        return
      }
      if (req.url === '/remote/v1/peer/events') {
        endedStreamAttempts += 1
        if (endedStreamAttempts > 1) {
          json(res, 401, { ok: false, code: item.code, error: '本次连接已失效' })
          return
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`event: grant\ndata: ${JSON.stringify(endedGrant)}\n\n`)
        res.end()
        return
      }
      json(res, 404, { ok: false, error: 'not found' })
    })
    const endedDir = join(root, `ended-${index}`)
    await mkdir(endedDir, { recursive: true })
    await writeFile(join(endedDir, 'peers.json'), JSON.stringify({ version: 1, peers: [] }), 'utf8')
    const { PeerClient: EndedClient } = await buildClient(`peer-client-ended-${index}`, endedDir)
    const endedClient = new EndedClient()
    const paired = await endedClient.pair(endedEndpoint.address.replace(/^http:\/\//, ''), '123456', async (identity) => {
      assert.equal(identity.computer, 'HOST-PC')
      return true
    })
    assert.equal(paired.ok, true, paired.error)
    assert.equal(pairBodies[0]?.deviceName, hostname(), '配对时只报计算机名')
    assert.match(String(pairBodies[0]?.deviceName), new RegExp(`^${hostname().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), '配对时不再带品牌前缀')
    assert.equal(pairBodies[0]?.kind, 'peer', '配对请求由隧道标成另一台砚')
    const linked = await endedClient.connect(paired.data.id, ['read'], '看一下')
    assert.equal(linked.ok, true, linked.error)
    await wait(4000)
    const endedState = (await endedClient.status()).peers.find((peer) => peer.id === paired.data.id).connection
    assert.equal(endedState.state, 'ended', `${item.label}后事件流被拒（${item.code}），状态及时变成「对方已结束连接」（attempts=${endedStreamAttempts}，${JSON.stringify(endedState)}）`)
    assert.equal(endedStreamAttempts, 2, `${item.label}后不再反复重连`)
    await wait(3500)
    assert.equal(endedStreamAttempts, 2, `${item.label}：结束后不再继续重连`)
    assert.equal((await endedClient.status()).peers.find((peer) => peer.id === paired.data.id).connection.state, 'ended', '状态保持已结束，不回退成失败')
    endedClient.closeAll()
    await endedEndpoint.close()
  }

  const deadDir = join(root, 'unreachable')
  await mkdir(deadDir, { recursive: true })
  await writeFile(join(deadDir, 'peers.json'), JSON.stringify({
    version: 1,
    peers: [{ id: 'peer-dead', computer: '关机的砚', address: 'http://127.0.0.1:9', pairedAt: 1, deviceId: 'dev-dead', token: 'raw:peer-token-dead-0001', hostKey: 'B'.repeat(87), keys: await clientKeys() }]
  }), 'utf8')
  const { PeerClient: DeadClient } = await buildClient('peer-client-dead', deadDir)
  const dead = new DeadClient()
  const startedAt = Date.now()
  assert.equal(await dead.remove('peer-dead'), true, '对端不可达时移除仍成功')
  assert.ok(Date.now() - startedAt < 5000, '对端不可达时最多等 3 秒通知超时')
  assert.deepEqual((await dead.status()).peers, [], '本地配对已删除')

  const unknownPeer = await dead.send('peer-missing', 's-1', '你好')
  assert.equal(unknownPeer.ok, false)
  assert.equal(unknownPeer.code, 'peer-auth-missing', '找不到配对或令牌失效时返回错误码')
  assert.doesNotMatch(unknownPeer.error, /[\u4e00-\u9fff]/, '主进程文案不写中文，由渲染端按语言显示')
  assert.equal((await dead.readImport('../etc')).code, 'import-invalid', '非法导入 id 返回错误码')
  dead.closeAll()

  const pairDir = join(root, 'pair-race')
  await mkdir(pairDir, { recursive: true })
  let pairCount = 0
  let raceEndpoint = null
  raceEndpoint = await servePeer(async (req, res) => {
    if (req.url === '/remote/v1/tunnel/invite') {
      invite(raceEndpoint, res)
      return
    }
    const index = ++pairCount
    await new Promise((resolve) => setTimeout(resolve, 20 + (index % 3) * 5))
    json(res, 200, { ok: true, token: `peer-token-race-${index}-0123456789`, deviceId: `dev-race-${index}`, computer: { name: `race-${index}` } })
  })
  const pairAddress = `127.0.0.1:${raceEndpoint.port}`
  const { PeerClient: RaceClient } = await buildClient('peer-client-pair-race', pairDir)
  const racing = new RaceClient()
  const paired = await Promise.all(Array.from({ length: 5 }, () => racing.pair(pairAddress, '123456', async () => true)))
  assert.ok(paired.every((result) => result.ok), `并发配对全部成功：${JSON.stringify(paired.filter((result) => !result.ok))}`)
  const reread = await new RaceClient().status()
  assert.equal(reread.peers.length, 5, '并发配对后每台电脑都留在设备表里')
  assert.deepEqual((await readdir(pairDir)).filter((name) => name.endsWith('.tmp')), [], '不残留临时文件')
  racing.closeAll()
  await raceEndpoint.close()

  console.log('peer-client: 幂等重试、peers.json 损坏备份、断流重连、断开与移除通知、配对设备名、对方结束连接、失败返回错误码、并发配对通过（全部经加密隧道）')
} finally {
  await rm(root, { recursive: true, force: true })
}
process.stdout.write('', () => process.exit(0))
