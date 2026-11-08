import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = await mkdtemp(join(tmpdir(), 'inkstone-relay-mobile-'))
await build({
  stdin: { contents: `export * from './src/main/relay-bridge/index'; export { RemoteServer } from './src/main/remote-server'; export { RemoteDeviceStore } from './src/main/remote-devices'`, resolveDir: process.cwd(), loader: 'ts' },
  outfile: join(root, 'desk.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent'
})
await build({
  stdin: { contents: `export * from './src/api/relay'; export { pairViaRelay, RemoteClient, RemoteEventStream } from './src/api/client'; export { parsePairingLink } from './src/pairLink'`, resolveDir: join(process.cwd(), 'mobile'), loader: 'ts' },
  outfile: join(root, 'mobile.mjs'), bundle: true, platform: 'neutral', format: 'esm', mainFields: ['module', 'main'], logLevel: 'silent'
})
const D = await import(pathToFileURL(join(root, 'desk.mjs')))

const relay = { host: null, clients: new Map(), next: 1 }
class HostSocket {
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
    if (msg.t === 'msg') setTimeout(() => c.onmessage?.({ data: msg.d }), 0)
    if (msg.t === 'kick') { relay.clients.delete(msg.c); setTimeout(() => c.onclose?.({ code: 1000 }), 0) }
  }
  close() { this.readyState = 3 }
}
globalThis.WebSocket = class {
  constructor(url) {
    this.url = url
    this.id = relay.next++
    if (!relay.host) { setTimeout(() => this.onclose?.({ code: 4004 }), 0); return }
    relay.clients.set(this.id, this)
    setTimeout(() => {
      relay.host.emit('message', { data: JSON.stringify({ t: 'open', c: this.id }) })
      this.onopen?.({})
    }, 0)
  }
  send(text) {
    if (relay.legacy && text.startsWith('{"t":"hi"')) { const hi = JSON.parse(text); delete hi.x; text = JSON.stringify(hi) }
    relay.host.emit('message', { data: JSON.stringify({ t: 'msg', c: this.id, d: text }) })
  }
  close() { if (relay.clients.delete(this.id)) relay.host.emit('message', { data: JSON.stringify({ t: 'close', c: this.id }) }) }
}
const M = await import(pathToFileURL(join(root, 'mobile.mjs')))

const dataDir = await mkdtemp(join(tmpdir(), 'inkstone-relay-mobile-data-'))
const devices = new D.RemoteDeviceStore(dataDir)
const handlers = {
  async snapshot() { return { sessions: [{ id: 's1', name: relay.bigName ?? '会话一' }] } }, async history() { return { ok: true } }, async command() { return { ok: true } }
}
const relayToken = 'mobile-test-token-0123456789'
const server = new D.RemoteServer({ host: '127.0.0.1', port: 0, devices, handlers, relayToken })
await server.start()
const bridge = new D.RelayBridge(dataDir, { target: () => ({ host: '127.0.0.1', port: server.info.port, relayToken }), startYanPairing: () => devices.startPairing(), WebSocket: HostSocket })
await bridge.apply({ enabled: true, url: 'https://relay.example.test' })
await new Promise((r) => setTimeout(r, 20))

let failures = 0
const check = async (name, fn) => { try { await fn(); console.log(`✔ ${name}`) } catch (error) { failures++; console.log(`✖ ${name}\n  ${error?.stack ?? error}`) } }

try {
  await check('UTF-8 与 base64 自带实现与 Node 一致（含跨块）', async () => {
    const text = '中文 emoji 😀 与 ascii'
    assert.deepEqual(Buffer.from(M.utf8ToBytes(text)), Buffer.from(text))
    const bytes = Buffer.from(text)
    const cut = bytes.indexOf(Buffer.from('😀')) + 2
    const first = M.decodeUtf8(bytes.subarray(0, cut))
    assert.ok(first.rest > 0)
    for (const n of [0, 1, 2, 3, 4, 5, 100]) {
      const b = Buffer.from(Array.from({ length: n }, (_, i) => (i * 37) & 255))
      assert.equal(M.toB64(b), b.toString('base64'))
      assert.deepEqual(Buffer.from(M.fromB64(b.toString('base64'))), b)
      assert.equal(M.toB64u(b), b.toString('base64url'))
      assert.deepEqual(Buffer.from(M.fromB64u(b.toString('base64url'))), b)
    }
    let seed = 7
    const rand = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n }
    for (let round = 0; round < 300; round++) {
      const b = Buffer.from(Array.from({ length: rand(9000) }, () => rand(256)))
      assert.equal(M.toB64(b), b.toString('base64'))
      assert.equal(M.toB64u(b), b.toString('base64url'))
      assert.deepEqual(Buffer.from(M.fromB64(b.toString('base64'))), b)
      assert.deepEqual(Buffer.from(M.fromB64u(b.toString('base64url'))), b)
      assert.equal(M.bytesToUtf8(b), b.toString('utf8'))
      const pool = ['a', '中', 'é', '😀', '\n', '"', '𐀀', '🤖']
      const s = Array.from({ length: rand(6000) }, () => pool[rand(pool.length)]).join('')
      const bytes = Buffer.from(s)
      assert.deepEqual(Buffer.from(M.utf8ToBytes(s)), bytes)
      const cut = rand(bytes.length + 1)
      const head = M.decodeUtf8(bytes.subarray(0, cut))
      const tail = M.decodeUtf8(bytes.subarray(cut - head.rest))
      assert.equal(head.text + tail.text, s)
    }
    assert.equal(M.bytesToUtf8(Buffer.from([0xff, 0x41, 0xe4, 0xb8])), Buffer.from([0xff, 0x41, 0xe4, 0xb8]).toString('utf8'))
    assert.throws(() => M.fromB64u('ab+c'))
    assert.throws(() => M.fromB64('a$bc'))
  })

  let connection
  await check('手机扫码 → 经中继两层配对（纯 JS 加密与桌面 WebCrypto 互通）', async () => {
    const { link } = await bridge.pairLink('phone')
    for (const variant of [link, link.replace('yan://', 'inkstone://'), link.slice(link.indexOf('#'))]) assert.ok(M.parsePairingLink(variant)?.relay, variant.slice(0, 20))
    const agentLink = (await bridge.pairLink('agent')).link
    assert.equal(M.parsePairingLink(agentLink), null)
    const prefill = M.parsePairingLink((await bridge.pairLink('phone')).link)
    connection = await M.pairViaRelay(prefill.relay, '测试手机')
    assert.match(connection.baseUrl, /^relay:\/\//)
    assert.ok(connection.token && connection.relay?.clientKey)
    assert.equal((await bridge.status()).clients.filter((c) => c.online).length, 1)
  })

  await check('配对后的能力协商经隧道，不再宣告 Agent Hub', async () => {
    const client = new M.RemoteClient(connection)
    const info = await client.info()
    assert.ok(info.capabilities.includes('sessions'))
    assert.ok(!info.capabilities.includes('agent-hub'))
  })

  await check('事件流经隧道到达，中文不乱码', async () => {
    const got = []
    let open
    const opened = new Promise((r) => { open = r })
    const stream = new M.RemoteEventStream(connection, {
      onEvent: (e) => got.push(e), onResync: () => undefined, onUnauthorized: () => undefined,
      onState: (s) => { if (s === 'open') open() }
    })
    stream.start()
    await opened
    server.publish({ ch: 'notify', payload: { text: '来自电脑的通知：任务完成 ✅' } })
    await new Promise((r) => setTimeout(r, 200))
    stream.stop()
    assert.ok(JSON.stringify(got).includes('来自电脑的通知：任务完成 ✅'), JSON.stringify(got).slice(0, 200))
  })

  await check('协议 v2：文本不再套 base64，大响应分块拼回不乱码', async () => {
    const tunnel = M.RelayTunnel.for(connection.relay)
    assert.equal(tunnel.version, 2)
    relay.bigName = '长标题😀'.repeat(150_000)
    try {
      const client = new M.RemoteClient(connection)
      const sessions = await client.sessions()
      assert.equal(JSON.stringify(sessions).includes(relay.bigName), true)
    } finally { delete relay.bigName }
  })

  await check('旧手机（握手不带 x）仍走 v1，请求与事件流正常', async () => {
    relay.legacy = true
    const old = new M.RelayTunnel(connection.relay)
    try {
      const res = await old.request('GET', '/remote/v1/info', { headers: { authorization: `Bearer ${connection.token}` } })
      assert.equal(old.version, 1)
      assert.equal(res.status, 200)
      assert.ok(res.text.includes('"sessions"'), res.text.slice(0, 200))
      const got = []
      let started
      const opened = new Promise((r) => { started = r })
      const stop = old.stream('/remote/v1/events?since=0', { authorization: `Bearer ${connection.token}`, accept: 'text/event-stream' }, { onStart: () => started(), onChunk: (t) => got.push(t), onEnd: () => undefined })
      await opened
      server.publish({ ch: 'notify', payload: { text: '旧版协议的中文 😀' } })
      await new Promise((r) => setTimeout(r, 200))
      stop()
      assert.ok(got.join('').includes('旧版协议的中文 😀'))
      const post = await old.request('POST', '/remote/v1/device', { headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: '旧手机' }) })
      assert.ok(post.status < 500, String(post.status))
    } finally {
      relay.legacy = false
      old.close()
    }
  })

  await check('原生 AES-GCM（按 Android 实现模拟）通过自检，并与电脑互通', async () => {
    const { createCipheriv, createDecipheriv } = await import('node:crypto')
    const iv = (n) => { const b = Buffer.alloc(12); b.writeBigUInt64BE(BigInt(n), 4); return b }
    const native = {
      open(key, frame, expected) {
        const bytes = Buffer.from(frame.slice(2), 'base64url')
        const n = Number(bytes.readBigUInt64BE(0))
        if (n !== expected) throw new Error('count')
        const d = createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64url'), iv(n))
        d.setAuthTag(bytes.subarray(bytes.length - 16))
        return Buffer.concat([d.update(bytes.subarray(8, bytes.length - 16)), d.final()]).toString('utf8')
      },
      seal(key, counter, text) {
        const c = createCipheriv('aes-256-gcm', Buffer.from(key, 'base64url'), iv(counter))
        const ct = Buffer.concat([c.update(text, 'utf8'), c.final(), c.getAuthTag()])
        const head = Buffer.alloc(8)
        head.writeBigUInt64BE(BigInt(counter))
        return 'x.' + Buffer.concat([head, ct]).toString('base64url')
      }
    }
    assert.equal(M.setFrameCipher({ open: () => 'nope', seal: native.seal }), false)
    assert.equal(M.setFrameCipher(native), true)
    const tunnel = new M.RelayTunnel(connection.relay)
    try {
      const res = await tunnel.request('GET', '/remote/v1/info', { headers: { authorization: `Bearer ${connection.token}` } })
      assert.equal(res.status, 200)
      const got = []
      let started
      const opened = new Promise((r) => { started = r })
      const stop = tunnel.stream('/remote/v1/events?since=0', { authorization: `Bearer ${connection.token}`, accept: 'text/event-stream' }, { onStart: () => started(), onChunk: (t) => got.push(t), onEnd: () => undefined })
      await opened
      server.publish({ ch: 'notify', payload: { text: '原生解密的中文 😀' } })
      await new Promise((r) => setTimeout(r, 200))
      stop()
      assert.ok(got.join('').includes('原生解密的中文 😀'))
    } finally {
      M.setFrameCipher(null)
      tunnel.close()
    }
  })

  await check('电脑撤销后，手机的请求失败', async () => {
    for (const c of (await bridge.status()).clients) await bridge.revoke(c.id)
    const client = new M.RemoteClient(connection)
    await assert.rejects(client.info(), (e) => e.status === 0 || e.status === 401)
  })
} finally {
  bridge.stop()
  await server.stop()
}
if (failures) { console.log(`\n${failures} 项失败`); process.exit(1) }
console.log('\n手机端与桌面中继桥互通检查全部通过。')
process.exit(0)
