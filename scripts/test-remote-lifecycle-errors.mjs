import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const stubSource = [
  "export const nativeImage = {}",
  "export const safeStorage = { isEncryptionAvailable: () => false }",
  "export const app = { getPath: () => process.env.TEMP || '.', getAppPath: () => '.', isPackaged: false, on() {} }",
  "export default {}"
].join("\n")
const electronStub = {
  name: 'electron-stub',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-stub' }))
    b.onLoad({ filter: /.*/, namespace: 'electron-stub' }, () => ({ contents: stubSource, loader: 'js' }))
  }
}
const root = await mkdtemp(join(tmpdir(), 'inkstone-remote-lifecycle-'))
await build({
  stdin: { contents: `export { RemoteAccess } from './src/main/remote-access'; export { RemoteServer } from './src/main/remote-server'`, resolveDir: process.cwd(), loader: 'ts' },
  outfile: join(root, 'm.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', plugins: [electronStub],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" }
})
const M = await import(pathToFileURL(join(root, 'm.mjs')).href)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let failures = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`✔ ${name}`) } catch (error) { failures++; console.log(`✖ ${name}\n  ${error?.stack ?? error}`) }
}

const freePort = () => new Promise((resolve) => {
  const s = createServer()
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
})
const listening = (port) => new Promise((resolve) => {
  const socket = connect(port, '127.0.0.1')
  socket.once('connect', () => { socket.destroy(); resolve(true) })
  socket.once('error', () => resolve(false))
})
const handlers = { async snapshot() { return { sessions: [] } }, async history() { return { ok: true } }, async command() { return { ok: true } } }

await check('stop 与在途 apply 竞争：不残留监听服务，停止后 apply 不再启动', async () => {
  for (const delay of [0, 1, 3, 10, 30]) {
    const port = await freePort()
    const access = new M.RemoteAccess(join(root, `data-${delay}`), handlers)
    const applying = access.apply({ enabled: true, bind: 'loopback', port })
    if (delay) await sleep(delay)
    await access.stop()
    await applying
    assert.equal(access.server, null, `delay=${delay} 主服务不应残留`)
    assert.equal(access.relayServer, null, `delay=${delay} 中继内部服务不应残留`)
    assert.equal(await listening(port), false, `delay=${delay} 端口不应仍在监听`)
    await access.apply({ enabled: true, bind: 'loopback', port })
    assert.equal(access.server, null, '停止后 apply 不再启动')
    assert.equal(await listening(port), false)
  }
})

await check('正常 apply 后 stop 仍会关闭服务', async () => {
  const port = await freePort()
  const access = new M.RemoteAccess(join(root, 'data-normal'), handlers)
  await access.apply({ enabled: true, bind: 'loopback', port })
  assert.equal(await listening(port), true)
  await access.stop()
  assert.equal(await listening(port), false)
})

const server = new M.RemoteServer({ host: '127.0.0.1', port: 0, token: 'test-remote-token-1234567890', handlers })
await server.start()
const post = (path, body, headers = {}) => new Promise((resolve, reject) => {
  const req = httpRequest({ host: '127.0.0.1', port: server.info.port, path, method: 'POST', headers: { authorization: 'Bearer test-remote-token-1234567890', ...headers } }, (res) => {
    let text = ''
    res.on('data', (c) => { text += c })
    res.on('end', () => resolve({ status: res.statusCode, text }))
  })
  req.on('error', reject)
  req.end(body)
})

await check('坏 JSON 返回 400，请求体超限返回 413，对象以外返回 400', async () => {
  const bad = await post('/remote/v1/device', '{ 不是 json', { 'content-type': 'application/json' })
  assert.equal(bad.status, 400, bad.text)
  assert.equal(JSON.parse(bad.text).ok, false)
  const array = await post('/remote/v1/device', '[1,2]', { 'content-type': 'application/json' })
  assert.equal(array.status, 400, array.text)
  const huge = await post('/remote/v1/device', JSON.stringify({ name: 'x'.repeat(200 * 1024) }), { 'content-type': 'application/json' })
  assert.equal(huge.status, 413, huge.text)
  const ok = await post('/remote/v1/device', JSON.stringify({ name: '手机' }), { 'content-type': 'application/json' })
  assert.equal(ok.status, 403, '合法 JSON 仍按原逻辑处理（无设备令牌）')
})

await check('分块上传无 content-length 的超限体同样返回 413', async () => {
  const status = await new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: server.info.port, path: '/remote/v1/device', method: 'POST', headers: { authorization: 'Bearer test-remote-token-1234567890', 'transfer-encoding': 'chunked' } }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    req.on('error', (error) => resolve(`error:${error.code}`))
    req.write('{"name":"')
    req.write('x'.repeat(100 * 1024))
    req.end('"}')
  })
  assert.ok(status === 413 || String(status).startsWith('error:'), `实际 ${status}`)
  assert.equal(status, 413)
})

await server.stop()
await rm(root, { recursive: true, force: true })
if (failures) {
  console.log(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\nremote lifecycle/errors：stop 与 apply 竞争、坏 JSON 400、超限 413 通过')
process.exit(0)
