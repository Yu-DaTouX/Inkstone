import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

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
  await build({ entryPoints: ['src/main/peer-client.ts'], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', plugins: [electronStub] })
  process.env.YAN_DATA_DIR = dataDir
  return import(pathToFileURL(outfile).href)
}

try {
  const retryDir = join(root, 'retry')
  await mkdir(retryDir, { recursive: true })
  const seen = []
  let attempts = 0
  const server = createServer((req, res) => {
    attempts += 1
    seen.push({ key: req.headers['idempotency-key'], path: req.url })
    if (attempts === 1) {
      req.socket.destroy()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, data: { accepted: true } }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = `http://127.0.0.1:${server.address().port}`
  await writeFile(join(retryDir, 'peers.json'), JSON.stringify({
    version: 1,
    peers: [{ id: 'peer-1', computer: '另一台砚', address, pairedAt: 1, deviceId: 'dev-1', token: 'raw:peer-token-0123456789' }]
  }), 'utf8')

  const { PeerClient } = await buildClient('peer-client-retry', retryDir)
  const client = new PeerClient()
  const sent = await client.send('peer-1', 's-1', '你好')
  assert.equal(sent.ok, true, '传输失败后按同一幂等键重试一次并成功')
  assert.equal(attempts, 2, '只重试一次')
  assert.equal(seen[0].key, seen[1].key, '重试沿用同一个幂等键')
  assert.ok(typeof seen[0].key === 'string' && seen[0].key.startsWith('peer-'), '幂等键仍由对端客户端生成')
  assert.equal(seen[1].path, '/remote/v1/peer/sessions/s-1/messages')
  await new Promise((resolve) => server.close(resolve))

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
  const peerServer = createServer((req, res) => {
    if (req.url === '/remote/v1/peer/connect') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, data: { grant } }))
      return
    }
    if (req.url === '/remote/v1/peer/events') {
      streamAttempts += 1
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`event: grant\ndata: ${JSON.stringify(grant)}\n\n`)
      res.end()
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'not found' }))
  })
  await new Promise((resolve) => peerServer.listen(0, '127.0.0.1', resolve))
  const reconnectDir = join(root, 'reconnect')
  await mkdir(reconnectDir, { recursive: true })
  await writeFile(join(reconnectDir, 'peers.json'), JSON.stringify({
    version: 1,
    peers: [{ id: 'peer-1', computer: '另一台砚', address: `http://127.0.0.1:${peerServer.address().port}`, pairedAt: 1, deviceId: 'dev-1', token: 'raw:peer-token-0123456789' }]
  }), 'utf8')
  const { PeerClient: ReconnectClient } = await buildClient('peer-client-reconnect', reconnectDir)
  const reconnect = new ReconnectClient()
  const connected = await reconnect.connect('peer-1', ['read'], '看一下')
  assert.equal(connected.ok, true, '对端批准后连上事件流')
  assert.equal(streamAttempts, 1)
  await new Promise((resolve) => setTimeout(resolve, 3500))
  assert.ok(streamAttempts >= 2, '事件流断开后自动重连一次，不直接置失败')
  reconnect.disconnect('peer-1')
  const beforeDisconnect = streamAttempts
  await new Promise((resolve) => setTimeout(resolve, 3500))
  assert.equal(streamAttempts, beforeDisconnect, '主动断开后不再重连')
  await new Promise((resolve) => peerServer.close(resolve))

  console.log('peer-client: 幂等重试、peers.json 损坏备份与断流重连通过')
} finally {
  await rm(root, { recursive: true, force: true })
}
