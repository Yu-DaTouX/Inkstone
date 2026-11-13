import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = await mkdtemp(join(tmpdir(), 'inkstone-relay-budget-'))
await build({
  stdin: {
    contents: `export { TunnelSession } from './src/main/relay-bridge/tunnel'; export { RelayLink } from './src/main/relay-bridge/link'; export * from './src/main/relay-bridge/crypto'`,
    resolveDir: process.cwd(), loader: 'ts'
  },
  outfile: join(root, 'm.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent'
})
const M = await import(pathToFileURL(join(root, 'm.mjs')).href)

const MB = 1024 * 1024
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (fn, ms = 10_000, label = 'condition') => {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error(`等待超时：${label}`)
    await sleep(5)
  }
}
let failures = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`✔ ${name}`) } catch (error) { failures++; console.log(`✖ ${name}\n  ${error?.stack ?? error}`) }
}

const patternByte = (offset) => (offset ^ (offset >>> 8) ^ (offset >>> 16)) & 0xff
const patternBlock = (offset, length) => {
  const out = Buffer.allocUnsafe(length)
  for (let i = 0; i < length; i++) out[i] = patternByte(offset + i)
  return out
}
const matchesPattern = (offset, bytes) => {
  for (let i = 0; i < bytes.length; i++) if (bytes[i] !== patternByte(offset + i)) return false
  return true
}

const upstream = { bigServed: 0, bigTotal: 0, sseClosed: false, sseSent: 0 }
const http = createServer((req, res) => {
  if (req.url.startsWith('/remote/v1/big')) {
    const total = Number(new URL(req.url, 'http://x').searchParams.get('mb')) * MB
    upstream.bigServed = 0
    upstream.bigTotal = total
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': total })
    const pump = () => {
      while (upstream.bigServed < total) {
        const n = Math.min(64 * 1024, total - upstream.bigServed)
        const ok = res.write(patternBlock(upstream.bigServed, n))
        upstream.bigServed += n
        if (!ok) return void res.once('drain', pump)
      }
      res.end()
    }
    pump()
    return
  }
  if (req.url.startsWith('/remote/v1/chunked')) {
    const kb = Number(new URL(req.url, 'http://x').searchParams.get('kb'))
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    for (let off = 0; off < kb * 1024; off += 64 * 1024) res.write(patternBlock(off, Math.min(64 * 1024, kb * 1024 - off)))
    res.end()
    return
  }
  if (req.url.startsWith('/remote/v1/sse')) {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    upstream.sseClosed = false
    upstream.sseSent = 0
    const filler = 'x'.repeat(32 * 1024)
    const timer = setInterval(() => {
      upstream.sseSent += 1
      res.write(`id: ${upstream.sseSent}\ndata: ${filler}\n\n`)
    }, 1)
    res.on('close', () => {
      clearInterval(timer)
      upstream.sseClosed = true
    })
    return
  }
  res.writeHead(404).end()
})
await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve))
const port = http.address().port

async function openSession({ kind = 'phone', text = false } = {}) {
  const hostKey = await M.generateKeyPair()
  const pipe = {
    frames: [], bufferedBytes: 0, peak: 0, paused: 0, resumed: 0, closed: null,
    send(frame) {
      this.frames.push(frame)
      this.bufferedBytes += frame.length
      this.peak = Math.max(this.peak, this.bufferedBytes)
    },
    close(code) { this.closed = code },
    buffered() { return this.bufferedBytes },
    pause() { this.paused++ },
    resume() { this.resumed++ }
  }
  const session = new M.TunnelSession(pipe, {
    hostKey,
    authenticate: async (clientKey, name) => ({ ok: true, client: { id: 'c1', key: clientKey, name, kind, addedAt: 1, lastSeenAt: 1, revokedAt: null, pairedAt: 1, pendingUntil: null, online: true } }),
    target: () => ({ host: '127.0.0.1', port, relayToken: 'tok' })
  })
  const clientStatic = await M.generateKeyPair()
  const clientEph = await M.generateKeyPair()
  pipe.onmessage(JSON.stringify({ t: 'hi', v: 1, ...(text ? { x: 2 } : {}), c: M.toB64u(clientStatic.raw), e: M.toB64u(clientEph.raw) }))
  await until(() => pipe.frames.length > 0, 5000, 'hi')
  const hi = JSON.parse(pipe.frames.shift())
  pipe.bufferedBytes = 0
  const channel = await M.clientSession({ clientStatic, clientEph, serverStaticRaw: hostKey.raw, serverEphRaw: M.fromB64u(hi.e) })
  pipe.onmessage(await channel.seal({ t: 'auth', name: 'test' }))
  await until(() => pipe.frames.length > 0, 5000, 'welcome')
  const welcome = await channel.open(pipe.frames.shift())
  pipe.bufferedBytes = 0
  assert.equal(welcome.t, 'welcome')
  let seq = 0
  const client = {
    pipe, session, channel,
    async send(msg) { pipe.onmessage(await channel.seal(msg)) },
    async next() {
      await until(() => pipe.frames.length > 0, 20_000, 'frame')
      const frame = pipe.frames.shift()
      pipe.bufferedBytes -= frame.length
      return channel.open(frame)
    },
    request(method, path, extra = {}) {
      const id = `r${++seq}`
      return { id, send: () => client.send({ t: 'req', id, method, path, headers: {}, ...extra }) }
    }
  }
  return client
}

await check('100MB 二进制响应边收边分片：帧顺序正确、发送缓冲有界', async () => {
  const client = await openSession()
  const rssBefore = process.memoryUsage().rss
  let rssPeak = rssBefore
  const req = client.request('GET', '/remote/v1/big?mb=100')
  await req.send()
  const head = await client.next()
  assert.equal(head.t, 'res')
  assert.equal(head.stream, true)
  assert.equal(head.id, req.id)
  let offset = 0
  let chunks = 0
  for (;;) {
    const msg = await client.next()
    if (msg.t === 'end') {
      assert.equal(msg.error, undefined)
      break
    }
    assert.equal(msg.t, 'chunk')
    const bytes = Buffer.from(msg.data, 'base64')
    assert.ok(matchesPattern(offset, bytes), `分片内容乱序或损坏 @${offset}`)
    offset += bytes.length
    chunks++
    if (chunks % 20 === 0) {
      rssPeak = Math.max(rssPeak, process.memoryUsage().rss)
      await sleep(2)
    }
  }
  assert.equal(offset, 100 * MB)
  assert.ok(chunks >= 100 * MB / (512 * 1024), `按 512KB 分片，实际 ${chunks} 片`)
  assert.ok(client.pipe.peak <= 12 * MB, `发送缓冲峰值 ${(client.pipe.peak / MB).toFixed(1)}MB 应不超过 12MB`)
  console.log(`  峰值缓冲 ${(client.pipe.peak / MB).toFixed(1)}MB，RSS 增长约 ${((rssPeak - rssBefore) / MB).toFixed(0)}MB，分片 ${chunks}`)
  client.session.close()
})

await check('小响应仍整包内联，未知长度超过内联阈值时转为分片', async () => {
  const client = await openSession()
  const small = client.request('GET', '/remote/v1/big?mb=0')
  await small.send()
  const empty = await client.next()
  assert.equal(empty.t, 'res')
  assert.equal(empty.stream, undefined)
  assert.equal(empty.body, undefined)
  const mid = client.request('GET', '/remote/v1/chunked?kb=300')
  await mid.send()
  const inline = await client.next()
  assert.equal(inline.stream, undefined)
  assert.ok(matchesPattern(0, Buffer.from(inline.body, 'base64')) && Buffer.from(inline.body, 'base64').length === 300 * 1024)
  const big = client.request('GET', '/remote/v1/chunked?kb=2000')
  await big.send()
  const head = await client.next()
  assert.equal(head.stream, true)
  let offset = 0
  for (;;) {
    const msg = await client.next()
    if (msg.t === 'end') break
    const bytes = Buffer.from(msg.data, 'base64')
    assert.ok(matchesPattern(offset, bytes))
    offset += bytes.length
  }
  assert.equal(offset, 2000 * 1024)
  client.session.close()
})

await check('不读数据的慢接收端：缓冲有界、上游被暂停；恢复读取后顺序完整', async () => {
  const client = await openSession()
  const req = client.request('GET', '/remote/v1/big?mb=64')
  await req.send()
  await sleep(1500)
  assert.ok(client.pipe.bufferedBytes <= 12 * MB, `慢接收端缓冲 ${(client.pipe.bufferedBytes / MB).toFixed(1)}MB 应不超过 12MB`)
  const served = upstream.bigServed
  assert.ok(served < 48 * MB, `上游只应写出有限字节，实际 ${(served / MB).toFixed(1)}MB / 64MB`)
  await sleep(300)
  assert.equal(upstream.bigServed, served, '暂停后上游不再前进')
  let offset = 0
  const head = await client.next()
  assert.equal(head.stream, true)
  for (;;) {
    const msg = await client.next()
    if (msg.t === 'end') break
    const bytes = Buffer.from(msg.data, 'base64')
    assert.ok(matchesPattern(offset, bytes), `恢复后分片乱序 @${offset}`)
    offset += bytes.length
    if (offset % (8 * MB) < 512 * 1024) await sleep(5)
  }
  assert.equal(offset, 64 * MB)
  assert.ok(client.pipe.peak <= 12 * MB, `峰值 ${(client.pipe.peak / MB).toFixed(1)}MB`)
  client.session.close()
})

await check('慢接收端下 SSE 积压超限：以带错误的 end 结束该流，已发事件连续不丢', async () => {
  const client = await openSession({ text: true })
  const req = client.request('GET', '/remote/v1/sse')
  await req.send()
  await until(() => upstream.sseClosed, 15_000, 'SSE 被结束')
  assert.ok(client.pipe.peak <= 16 * MB, `SSE 缓冲峰值 ${(client.pipe.peak / MB).toFixed(1)}MB`)
  const head = await client.next()
  assert.equal(head.stream, true)
  let text = ''
  let last
  for (;;) {
    const msg = await client.next()
    if (msg.t === 'end') {
      last = msg
      break
    }
    text += msg.text
  }
  assert.ok(typeof last.error === 'string' && last.error.length > 0, '结束帧带错误，让客户端用 last-event-id 续传')
  const events = text.split('\n\n').filter((part) => part.startsWith('id: '))
  assert.ok(events.length > 10, `应先转发一批事件：${events.length}`)
  events.forEach((part, index) => assert.equal(Number(part.split('\n')[0].slice(4)), index + 1, '事件 id 连续，不静默丢事件'))
  client.session.close()
})

await check('流式上传一律拒绝，不转发到电脑', async () => {
  const client = await openSession()
  const req = client.request('POST', '/remote/v1/sessions/s/messages', { stream: 'in' })
  await req.send()
  const res = await client.next()
  assert.equal(res.t, 'res')
  assert.equal(res.status, 400)
  client.session.close()
})

class FakeWs {
  static all = []
  constructor(url) {
    this.url = url
    this.readyState = 0
    this.bufferedAmount = 0
    this.sent = []
    this.listeners = {}
    FakeWs.all.push(this)
  }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn) }
  emit(type, ev = {}) { for (const fn of this.listeners[type] ?? []) fn(ev) }
  send(text) { this.sent.push(text) }
  close() { this.readyState = 3 }
  open() { this.readyState = 1; this.emit('open') }
}

const realSetTimeout = globalThis.setTimeout
globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, typeof ms === 'number' && ms >= 1000 ? ms / 100 : ms, ...rest)

await check('被顶替（4001）只通知一次且保留说明，不重连', async () => {
  FakeWs.all = []
  const states = []
  const link = new M.RelayLink({ url: 'https://relay.test', secret: 's', onPipe: () => {}, onState: (c, d) => states.push([c, d]), WebSocket: FakeWs })
  link.start()
  FakeWs.all[0].open()
  FakeWs.all[0].emit('close', { code: 4001 })
  assert.equal(states.length, 2, JSON.stringify(states))
  assert.deepEqual(states[0], [true, undefined])
  assert.equal(states[1][0], false)
  assert.match(states[1][1], /顶替|replaced/)
  await sleep(100)
  assert.equal(FakeWs.all.length, 1, '4001 不自动重连')
  link.stop()
})

await check('普通断开同样只通知一次并保留断开码，随后重连', async () => {
  FakeWs.all = []
  const states = []
  const link = new M.RelayLink({ url: 'https://relay.test', secret: 's', onPipe: () => {}, onState: (c, d) => states.push([c, d]), WebSocket: FakeWs })
  link.start()
  FakeWs.all[0].open()
  FakeWs.all[0].emit('close', { code: 1006 })
  assert.equal(states.filter(([c]) => c === false).length, 1)
  assert.match(states[1][1], /1006/)
  await until(() => FakeWs.all.length === 2, 2000, '重连')
  link.stop()
})

await check('CONNECTING 阶段超时：断开并安排重连', async () => {
  FakeWs.all = []
  const states = []
  const logs = []
  const link = new M.RelayLink({ url: 'https://relay.test', secret: 's', onPipe: () => {}, onState: (c, d) => states.push([c, d]), log: (t) => logs.push(t), WebSocket: FakeWs })
  link.start()
  assert.equal(FakeWs.all[0].readyState, 0)
  await until(() => FakeWs.all.length === 2, 3000, '超时后重连')
  assert.equal(FakeWs.all[0].readyState, 3, '旧连接被关闭')
  assert.ok(logs.some((t) => t.includes('超时')))
  assert.equal(states.length, 1)
  assert.equal(states[0][0], false)
  FakeWs.all[1].open()
  await sleep(300)
  assert.equal(FakeWs.all.length, 2, '已连接后超时计时器不再触发')
  assert.equal(link.connected, true)
  link.stop()
})

await check('pipe 数量上限、重复 open、超长消息与缓冲量透传', async () => {
  FakeWs.all = []
  const pipes = []
  const logs = []
  const link = new M.RelayLink({ url: 'https://relay.test', secret: 's', onPipe: (p) => pipes.push(p), log: (t) => logs.push(t), WebSocket: FakeWs })
  link.start()
  const ws = FakeWs.all[0]
  ws.open()
  for (let id = 1; id <= 40; id++) ws.emit('message', { data: JSON.stringify({ t: 'open', c: id }) })
  assert.equal(pipes.length, 32)
  const kicks = ws.sent.map((t) => JSON.parse(t)).filter((m) => m.t === 'kick').map((m) => m.c)
  assert.deepEqual(kicks, [33, 34, 35, 36, 37, 38, 39, 40])
  ws.emit('message', { data: JSON.stringify({ t: 'open', c: 1 }) })
  assert.equal(pipes.length, 32, '重复 open 不新建 pipe')
  ws.bufferedAmount = 12345
  assert.equal(pipes[0].buffered(), 12345)
  let received = 0
  pipes[0].onmessage = () => { received++ }
  ws.emit('message', { data: JSON.stringify({ t: 'msg', c: 1, d: 'x'.repeat(1000) }) })
  assert.equal(received, 1)
  ws.emit('message', { data: JSON.stringify({ t: 'msg', c: 1, d: 'x'.repeat(25 * MB + 8192) }) })
  assert.equal(received, 1, '超长消息不解析、不转发')
  assert.ok(logs.some((t) => t.includes('过大')))
  link.stop()
})

globalThis.setTimeout = realSetTimeout
await new Promise((resolve) => http.close(resolve))
http.closeAllConnections?.()
await rm(root, { recursive: true, force: true })
if (failures) {
  console.log(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\n中继传输预算检查全部通过：流式分片、背压、SSE 积压结束、拒绝流式上传、4001 说明、连接超时、pipe 上限、超长消息。')
process.exit(0)
