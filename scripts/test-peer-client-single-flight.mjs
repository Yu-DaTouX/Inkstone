import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { WebSocketServer } from 'ws'

const root = await mkdtemp(join(tmpdir(), 'inkstone-peer-single-flight-'))
const electronStub = {
  name: 'electron-stub',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-stub' }))
    b.onLoad({ filter: /.*/, namespace: 'electron-stub' }, () => ({
      contents: 'export const safeStorage = { isEncryptionAvailable: () => false, encryptString: (s) => Buffer.from(String(s)), decryptString: (b) => Buffer.from(b).toString() }\nexport default {}',
      loader: 'js'
    }))
  }
}
const dataDir = join(root, 'data')
await mkdir(dataDir, { recursive: true })
await build({
  entryPoints: ['src/main/peer-client.ts'], outfile: join(root, 'client.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', plugins: [electronStub],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" }
})
process.env.YAN_DATA_DIR = dataDir
const { PeerClient } = await import(pathToFileURL(join(root, 'client.mjs')).href)
await build({
  stdin: { contents: `export { TunnelSession } from './src/main/relay-bridge/tunnel'; export { generateKeyPair, exportKeyPair, toB64u } from './src/main/relay-bridge/crypto'`, resolveDir: process.cwd(), loader: 'ts' },
  outfile: join(root, 'tunnel.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent'
})
const T = await import(pathToFileURL(join(root, 'tunnel.mjs')).href)

const hostPair = await T.generateKeyPair()
const state = { connections: 0, reject: false, delayMs: 0 }
const http = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, data: { projects: [], sessions: [] } }))
})
const wss = new WebSocketServer({ server: http })
wss.on('connection', (ws) => {
  state.connections += 1
  if (state.reject) return ws.terminate()
  const pipe = {
    send: (text) => { if (ws.readyState === ws.OPEN) ws.send(text) },
    close: (code, reason) => ws.close(code ?? 1000, reason)
  }
  new T.TunnelSession(pipe, {
    hostKey: hostPair,
    authenticate: async (clientKey, name) => {
      if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs))
      return { ok: true, client: { id: 'relay-test', key: clientKey, name, kind: 'peer', addedAt: 1, lastSeenAt: 1, revokedAt: null, pairedAt: 1, pendingUntil: null, online: true } }
    },
    target: () => ({ host: '127.0.0.1', port: http.address().port, relayToken: '' })
  })
  ws.on('message', (data) => pipe.onmessage?.(String(data)))
  ws.on('close', () => pipe.onclose?.())
})
await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve))
const port = http.address().port
const pair = await T.generateKeyPair()
await writeFile(join(dataDir, 'peers.json'), JSON.stringify({
  version: 1,
  peers: [{ id: 'peer-1', computer: '另一台砚', address: `http://127.0.0.1:${port}`, pairedAt: 1, deviceId: 'dev-1', token: 'raw:peer-token-0123456789', hostKey: T.toB64u(hostPair.raw), keys: `raw:${JSON.stringify({ publicKey: T.toB64u(pair.raw), privateJwk: await T.exportKeyPair(pair) })}` }]
}), 'utf8')

try {
  const client = new PeerClient()
  state.delayMs = 150
  const results = await Promise.all(Array.from({ length: 6 }, () => client.sessions('peer-1')))
  assert.ok(results.every((r) => r.ok), `并发首次请求全部成功：${JSON.stringify(results.filter((r) => !r.ok))}`)
  assert.equal(state.connections, 1, `并发首次连接只建立一条隧道，实际 ${state.connections}`)
  const again = await client.sessions('peer-1')
  assert.ok(again.ok)
  assert.equal(state.connections, 1, '已连接后复用同一条隧道')
  client.closeAll()

  state.delayMs = 0
  state.reject = true
  const failing = new PeerClient()
  const failed = await Promise.all(Array.from({ length: 3 }, () => failing.sessions('peer-1')))
  assert.ok(failed.every((r) => !r.ok), '连接失败时并发请求都得到失败结果')
  state.reject = false
  const before = state.connections
  const recovered = await Promise.all(Array.from({ length: 3 }, () => failing.sessions('peer-1')))
  assert.ok(recovered.every((r) => r.ok), `失败后在途连接已清除，可重新连接：${JSON.stringify(recovered)}`)
  assert.equal(state.connections - before, 1, '恢复后同样只建立一条隧道')
  failing.closeAll()
  console.log('peer-client single-flight: 并发首次连接只建一条、失败后清除在途记录并可重连')
} finally {
  for (const ws of wss.clients) ws.terminate()
  await new Promise((resolve) => wss.close(resolve))
  await new Promise((resolve) => http.close(resolve))
  await rm(root, { recursive: true, force: true })
}
process.stdout.write('', () => process.exit(0))
