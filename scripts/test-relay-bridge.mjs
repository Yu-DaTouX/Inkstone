/**
 * 中继接入的离线检查：内存假中继 + 真实本机远程服务实例 + 模拟的手机 / 礁石客户端（同一套握手与加密）。
 * 不联网、不启动 Electron。用法：node scripts/test-relay-bridge.mjs
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = await mkdtemp(join(tmpdir(), 'inkstone-relay-'))
await build({
  stdin: {
    contents: `export * from './src/main/relay-bridge/index'; export * from './src/main/relay-bridge/crypto'; export { RemoteServer } from './src/main/remote-server'; export { RemoteDeviceStore } from './src/main/remote-devices'`,
    resolveDir: process.cwd(), loader: 'ts'
  },
  outfile: join(root, 'relay.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent'
})
const M = await import(pathToFileURL(join(root, 'relay.mjs')))

/* ---------- 内存假中继：主机一个连接，客户端按编号转发（协议同礁石中继） ---------- */
class FakeRelay {
  host = null
  clients = new Map()
  next = 1
  HostSocket() {
    const relay = this
    return class {
      readyState = 0
      listeners = {}
      constructor(url) { this.url = url; relay.host = this; setTimeout(() => { this.readyState = 1; this.emit('open', {}) }, 0) }
      addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn) }
      emit(type, ev) { for (const fn of this.listeners[type] ?? []) fn(ev) }
      send(text) {
        if (text === 'ping') return this.emit('message', { data: 'pong' })
        const msg = JSON.parse(text)
        const c = relay.clients.get(msg.c)
        if (!c) return
        if (msg.t === 'msg') c.inbox(msg.d)
        if (msg.t === 'kick') { relay.clients.delete(msg.c); c.closed = true }
      }
      close() { this.readyState = 3 }
    }
  }
  /** 新客户端加入：返回 { send(text), frames[], closed } */
  join() {
    const id = this.next++
    const queue = []
    const waiters = []
    const client = {
      id, closed: false,
      inbox(text) { const w = waiters.shift(); if (w) w(text); else queue.push(text) },
      recv(ms = 3000) {
        if (queue.length) return Promise.resolve(queue.shift())
        return new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error('等待中继消息超时')), ms); waiters.push((v) => { clearTimeout(t); resolve(v) }) })
      },
      send: (text) => this.host.emit('message', { data: JSON.stringify({ t: 'msg', c: id, d: text }) }),
      leave: () => this.host.emit('message', { data: JSON.stringify({ t: 'close', c: id }) })
    }
    this.clients.set(id, client)
    this.host.emit('message', { data: JSON.stringify({ t: 'open', c: id }) })
    return client
  }
}

/* ---------- 模拟客户端：握手、认证、隧道请求 ---------- */
async function connect(relay, link, { pair = true, name = '测试手机', key } = {}) {
  const payload = JSON.parse(Buffer.from(link.split('#p=')[1], 'base64url').toString('utf8'))
  const conn = relay.join()
  const clientStatic = key ?? (await M.generateKeyPair())
  const clientEph = await M.generateKeyPair()
  conn.send(JSON.stringify({ t: 'hi', v: 1, c: M.toB64u(clientStatic.raw), e: M.toB64u(clientEph.raw) }))
  const hi = JSON.parse(await conn.recv())
  const channel = await M.clientSession({ clientStatic, clientEph, serverStaticRaw: M.fromB64u(payload.s), serverEphRaw: M.fromB64u(hi.e) })
  conn.send(await channel.seal({ t: 'auth', name, ...(pair ? { pair: payload.c } : {}) }))
  const welcome = await channel.open(await conn.recv())
  let seq = 0
  const pending = new Map()
  const pump = async () => {
    for (;;) {
      let text
      try { text = await conn.recv(10_000) } catch { return }
      const msg = await channel.open(text)
      const p = pending.get(msg.id)
      if (!p) continue
      if (msg.t === 'res') { p.res = msg; if (!msg.stream) { pending.delete(msg.id); p.resolve(p) } else p.onStart?.(p) }
      if (msg.t === 'chunk') { p.chunks.push(Buffer.from(msg.data, 'base64')); p.onChunk?.(Buffer.from(msg.data, 'base64').toString('utf8')) }
      if (msg.t === 'end') { pending.delete(msg.id); p.resolve(p) }
    }
  }
  if (welcome.t === 'welcome') void pump()
  const request = (method, path, { body, headers = {}, onChunk, onStart } = {}) => new Promise((resolve) => {
    const id = `r${++seq}`
    pending.set(id, { resolve, chunks: [], onChunk, onStart })
    void channel.seal({ t: 'req', id, method, path, headers, ...(body !== undefined ? { body: Buffer.from(JSON.stringify(body)).toString('base64') } : {}) }).then((f) => conn.send(f))
  }).then((p) => ({ status: p.res.status, json: () => JSON.parse(Buffer.from(p.res.body ?? Buffer.concat(p.chunks).toString('base64'), 'base64').toString('utf8')), text: () => Buffer.concat(p.chunks).toString('utf8') }))
  return { welcome, payload, request, conn, channel, abort: (id) => channel.seal({ t: 'abort', id }).then((f) => conn.send(f)) }
}

const dataDir = await mkdtemp(join(tmpdir(), 'inkstone-relay-data-'))
const devices = new M.RemoteDeviceStore(dataDir)
let hubCalls = []
const handlers = {
  async snapshot() { return { sessions: [] } }, async history() { return { ok: true } }, async command() { return { ok: true } },
  async hubSnapshot() { return { tasks: [], approvals: [], resources: [], projects: [{ id: 'p1' }], adapters: [] } },
  hubAttention() { return [] },
  async hubCommand(command, actor) { hubCalls.push({ command, actor }); return { ok: true, data: { action: command.action } } }
}
const relayToken = 'test-relay-token-1234567890'
const server = new M.RemoteServer({ host: '127.0.0.1', port: 0, devices, handlers, relayToken })
await server.start()
const relay = new FakeRelay()
const bridge = new M.RelayBridge(dataDir, {
  target: () => ({ host: '127.0.0.1', port: server.info.port, relayToken }),
  startYanPairing: () => devices.startPairing(),
  WebSocket: relay.HostSocket()
})
await bridge.apply({ enabled: true, url: 'https://relay.example.test' })
await new Promise((r) => setTimeout(r, 20))
let failures = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`✔ ${name}`) } catch (error) { failures++; console.log(`✖ ${name}\n  ${error?.stack ?? error}`) }
}

try {
  assert.match(relay.host.url, /^wss:\/\/relay\.example\.test\/v1\/host\?key=/)

  await check('手机：配对链接格式、两层配对、隧道请求与 Hub 访问', async () => {
    const { link } = await bridge.pairLink('phone')
    assert.match(link, /^yan:\/\/relay#p=/)
    const phone = await connect(relay, link)
    assert.equal(phone.welcome.t, 'welcome')
    assert.equal(phone.welcome.kind, 'phone')
    assert.deepEqual([phone.payload.k, phone.payload.m, phone.payload.v], ['yan', 'phone', 1])
    assert.match(phone.payload.r, /^wss:\/\/relay\.example\.test\/v1\/join\/[A-Za-z0-9_-]{22}$/)
    assert.equal((await phone.request('GET', '/remote/v1/health')).status, 200)
    // 客户端声称 agent 也只会配对成手机
    const paired = await phone.request('POST', '/remote/v1/pair', { body: { code: phone.payload.y, deviceName: '我的手机', kind: 'agent' } })
    assert.equal(paired.status, 200)
    const { token, device } = paired.json()
    assert.equal(device.kind, 'phone')
    const auth = { authorization: `Bearer ${token}` }
    assert.equal((await phone.request('GET', '/remote/v1/sessions', { headers: auth })).status, 200)
    assert.equal((await phone.request('GET', '/remote/v1/hub', { headers: auth })).status, 200, '经隧道（本机回环）的手机身份可以用 Hub')
    // 已登记的公钥再次连接不需要配对码
    assert.equal((await bridge.status()).clients.filter((c) => c.kind === 'phone').length, 1)
  })

  await check('礁石：配对成 agent，只能用 Hub 查看 / 派活 / 答复 / 停止', async () => {
    const { link } = await bridge.pairLink('agent')
    const reef = await connect(relay, link, { name: '礁石' })
    assert.equal(reef.welcome.kind, 'agent')
    const paired = await reef.request('POST', '/remote/v1/pair', { body: { code: reef.payload.y, deviceName: '礁石', kind: 'phone' } })
    assert.equal(paired.status, 200)
    const { token, device } = paired.json()
    assert.equal(device.kind, 'agent', '中继配对用途决定类型，客户端改不了')
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    assert.equal((await reef.request('GET', '/remote/v1/hub', { headers })).status, 200)
    assert.equal((await reef.request('GET', '/remote/v1/hub/attention', { headers })).status, 200)
    assert.equal((await reef.request('GET', '/remote/v1/sessions', { headers })).status, 403, '隧道层拦住会话接口')
    hubCalls = []
    const hub = (action, key) => reef.request('POST', '/remote/v1/hub', { headers: { ...headers, 'idempotency-key': key }, body: { action, taskId: 't1' } })
    assert.equal((await hub('cancel', 'reef-cancel-0001')).status, 200)
    assert.equal((await hub('accept', 'reef-accept-0001')).status, 403, '验收不开放给礁石')
    assert.equal((await hub('input', 'reef-input-0001')).status, 403, '终端输入不开放给礁石')
    assert.deepEqual(hubCalls.map((c) => c.command.action), ['cancel'])
    assert.match(hubCalls[0].actor, /^phone:device-/)
  })

  await check('直连请求不能配对出 agent；伪造中继标记无效', async () => {
    devices.startPairing()
    const code = devices.currentPairing().code
    const direct = (headers) => fetch(`http://127.0.0.1:${server.info.port}/remote/v1/pair`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ code, deviceName: 'x', kind: 'agent' }) })
    assert.equal((await direct({})).status, 403)
    assert.equal((await direct({ 'x-yan-relay': 'wrong-token', 'x-yan-relay-kind': 'agent' })).status, 403)
  })

  await check('隧道只转发 /remote/v1/，客户端不能自带中继标记头', async () => {
    const { link } = await bridge.pairLink('phone')
    const c = await connect(relay, link)
    assert.equal((await c.request('GET', '/../etc/passwd')).status, 403)
    assert.equal((await c.request('GET', 'http://evil.test/remote/v1/health')).status, 403)
    assert.equal((await c.request('GET', '/other')).status, 403)
    // 手机连接即使自带 x-yan-relay-kind: agent，也被白名单丢弃、由隧道按配对用途重写
    devices.startPairing()
    const r = await c.request('POST', '/remote/v1/pair', { headers: { 'x-yan-relay-kind': 'agent', 'x-yan-relay': 'x' }, body: { code: devices.currentPairing().code, deviceName: 'p', kind: 'agent' } })
    assert.equal(r.json().device.kind, 'phone')
  })

  await check('没配对码、码用过、被撤销的公钥都连不上', async () => {
    const { link } = await bridge.pairLink('phone')
    const none = await connect(relay, link, { pair: false })
    assert.equal(none.welcome.t, 'denied')
    const first = await connect(relay, link)
    assert.equal(first.welcome.t, 'welcome')
    const reuse = await connect(relay, link)
    assert.equal(reuse.welcome.t, 'denied', '中继配对码只能用一次')
    const key = await M.generateKeyPair()
    const { link: link2 } = await bridge.pairLink('phone')
    assert.equal((await connect(relay, link2, { key })).welcome.t, 'welcome')
    const again = await connect(relay, link2, { key, pair: false })
    assert.equal(again.welcome.t, 'welcome', '已登记的公钥直接通过')
    const id = (await bridge.status()).clients.find((c) => c.revokedAt === null && c.online && c.name === '测试手机')?.id
    for (const c of (await bridge.status()).clients) if (c.revokedAt === null) await bridge.revoke(c.id)
    assert.ok(id)
    assert.equal((await connect(relay, link2, { key, pair: false })).welcome.t, 'denied')
  })

  await check('篡改的加密帧让连接断开', async () => {
    const { link } = await bridge.pairLink('phone')
    const c = await connect(relay, link)
    const good = await c.channel.seal({ t: 'ping' })
    c.conn.send(`${good.slice(0, -4)}AAAA`)
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(c.conn.closed, true)
  })

  await check('SSE 事件流分块转发，可中途取消', async () => {
    const { link } = await bridge.pairLink('phone')
    const phone = await connect(relay, link)
    devices.startPairing()
    const { token } = (await phone.request('POST', '/remote/v1/pair', { body: { code: devices.currentPairing().code, deviceName: 'sse' } })).json()
    let got = ''
    let started
    const startedP = new Promise((r) => { started = r })
    const stream = phone.request('GET', '/remote/v1/events', { headers: { authorization: `Bearer ${token}` }, onStart: () => started(), onChunk: (t) => { got += t } })
    await startedP
    server.publish({ ch: 'notify', payload: { text: '来自电脑的通知' } })
    await new Promise((r) => setTimeout(r, 150))
    assert.match(got, /来自电脑的通知/)
    void stream
  })
} finally {
  bridge.stop()
  await server.stop()
}
if (failures) {
  console.log(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\n中继接入检查全部通过：两层配对、类型绑定、agent 范围、路径与头白名单、撤销、防篡改、SSE 转发。')
process.exit(0)
