/**
 * 中继接入的互通检查：手机端的纯 JS 实现（mobile/src/api/relay.ts + client.ts，@noble 加密）
 * 对接桌面的真实中继桥与本机远程服务，经内存假中继：配对、请求、事件流、中文跨块解码、撤销。
 * 不联网、不启动 Electron / React Native。用法：node scripts/test-relay-mobile.mjs
 */
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

/* ---------- 内存假中继（同 test-relay-bridge.mjs） ---------- */
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
/** 手机端用的浏览器风格 WebSocket：连到假中继的 join */
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
  send(text) { relay.host.emit('message', { data: JSON.stringify({ t: 'msg', c: this.id, d: text }) }) }
  close() { if (relay.clients.delete(this.id)) relay.host.emit('message', { data: JSON.stringify({ t: 'close', c: this.id }) }) }
}
const M = await import(pathToFileURL(join(root, 'mobile.mjs')))

const dataDir = await mkdtemp(join(tmpdir(), 'inkstone-relay-mobile-data-'))
const devices = new D.RemoteDeviceStore(dataDir)
const handlers = {
  async snapshot() { return { sessions: [{ id: 's1', name: '会话一' }] } }, async history() { return { ok: true } }, async command() { return { ok: true } },
  async hubSnapshot() { return { tasks: [], approvals: [], resources: [], projects: [], adapters: [] } }, hubAttention() { return [] },
  async hubCommand(command) { return { ok: true, data: { action: command.action } } }
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
    }
  })

  let connection
  await check('手机扫码 → 经中继两层配对（纯 JS 加密与桌面 WebCrypto 互通）', async () => {
    const { link } = await bridge.pairLink('phone')
    for (const variant of [link, link.replace('yan://', 'inkstone://'), link.slice(link.indexOf('#'))]) assert.ok(M.parsePairingLink(variant)?.relay, variant.slice(0, 20))
    // 给礁石（agent）的链接，手机端不接
    const agentLink = (await bridge.pairLink('agent')).link
    assert.equal(M.parsePairingLink(agentLink), null)
    const prefill = M.parsePairingLink((await bridge.pairLink('phone')).link)
    connection = await M.pairViaRelay(prefill.relay, '测试手机')
    assert.match(connection.baseUrl, /^relay:\/\//)
    assert.ok(connection.token && connection.relay?.clientKey)
    assert.equal((await bridge.status()).clients.filter((c) => c.online).length, 1)
  })

  await check('配对后的请求、写操作与 Hub 都经隧道', async () => {
    const client = new M.RemoteClient(connection)
    const info = await client.info()
    assert.ok(info.capabilities.includes('agent-hub'))
    assert.deepEqual((await client.hubSnapshot()).tasks, [])
    assert.equal((await client.hubCommand({ action: 'cancel', taskId: 't1' })).action, 'cancel')
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
