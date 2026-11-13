import { request as httpRequest, type ClientRequest } from 'node:http'
import { StringDecoder } from 'node:string_decoder'
import { fromB64u, generateKeyPair, RELAY_PROTOCOL_VERSION, serverSession, toB64u, type KeyPair, type SecureChannel } from './crypto'
import type { RelayClient, RelayClientKind } from './store'
import { REMOTE_IDEMPOTENCY_HEADER, REMOTE_MESSAGE_MAX_BYTES } from '../../shared/remote-protocol'
import { pick } from '../../shared/ui-lang'

export interface Pipe {
  send(text: string): void
  close(code?: number, reason?: string): void
  onmessage?: (text: string) => void
  onclose?: () => void
  buffered?(): number
  pause?(): void
  resume?(): void
}

export interface TunnelTarget {
  host: string
  port: number
  relayToken: string
}

export interface TunnelHooks {
  hostKey: KeyPair
  authenticate(clientKey: string, name: string, pair: string | undefined, kind: RelayClientKind | undefined): Promise<{ ok: true; client: RelayClient } | { ok: false; reason: string }>
  target(): TunnelTarget | null
  onOpen?(session: TunnelSession): void
  onClose?(session: TunnelSession): void
  log?(text: string): void
}

const HANDSHAKE_TIMEOUT_MS = 10_000
const MAX_BODY_B64 = 1_200_000
const VOICE_MAX_BODY_BYTES = 6 * 1024 * 1024
const INLINE_RESPONSE = 600 * 1024
const CHUNK = 512 * 1024
const MAX_REQUESTS = 16
const MAX_STREAMS = 4
const COALESCE_MS = 50
const REQUEST_TIMEOUT_MS = 120_000
const SEND_HIGH_BYTES = 8 * 1024 * 1024
const SEND_LOW_BYTES = 2 * 1024 * 1024
const STREAM_BACKLOG_BYTES = 12 * 1024 * 1024
const INBOUND_HIGH_BYTES = 8 * 1024 * 1024
const INBOUND_LOW_BYTES = 2 * 1024 * 1024
const DRAIN_POLL_MS = 20
const FORWARD_HEADERS = ['authorization', 'content-type', 'x-yan-remote-token', REMOTE_IDEMPOTENCY_HEADER, 'last-event-id', 'accept']
const AGENT_PATHS = new Set(['/remote/v1/health', '/remote/v1/info', '/remote/v1/pair'])
const TEXT_PROTOCOL = 2

function textual(contentType: string | undefined): boolean {
  const type = (contentType ?? '').toLowerCase()
  return type.startsWith('text/') || type.includes('json') || type.includes('javascript') || type.includes('xml')
}

const STREAM_BROKEN = (): string => pick('电脑上的事件流异常断开', 'The event stream on the computer was interrupted')
const BODY_BROKEN = (): string => pick('电脑上的响应传输中断', 'The response transfer from the computer was interrupted')

type Pending = { req: ClientRequest; stream: boolean; finish?(error?: string): void }

const HANDSHAKE_FRAME_MAX = 4096
export const SEALED_FRAME_MAX = 24 * 1024 * 1024

function declaredKind(value: unknown): RelayClientKind | undefined {
  return value === 'phone' || value === 'peer' || value === 'agent' ? value : undefined
}

export class TunnelSession {
  private state: 'hello' | 'auth' | 'open' | 'closed' = 'hello'
  private channel: SecureChannel | undefined
  private clientKey = ''
  private version = RELAY_PROTOCOL_VERSION
  private chain: Promise<void> = Promise.resolve()
  private readonly timer: ReturnType<typeof setTimeout>
  private readonly pending = new Map<string, Pending>()
  private sealing = 0
  private inbound = 0
  private inboundPaused = false
  client: RelayClient | null = null

  constructor(readonly pipe: Pipe, private readonly hooks: TunnelHooks) {
    pipe.onmessage = (text) => {
      this.inbound += text.length
      if (!this.inboundPaused && this.inbound > INBOUND_HIGH_BYTES) {
        this.inboundPaused = true
        pipe.pause?.()
      }
      this.chain = this.chain.then(() => this.handle(text)).catch((error: unknown) => this.abort(error instanceof Error ? error.message : String(error))).finally(() => {
        this.inbound -= text.length
        if (this.inboundPaused && this.inbound <= INBOUND_LOW_BYTES) {
          this.inboundPaused = false
          if (this.state !== 'closed') pipe.resume?.()
        }
      })
    }
    pipe.onclose = () => this.closed()
    this.timer = setTimeout(() => {
      if (this.state !== 'open') this.abort('握手超时')
    }, HANDSHAKE_TIMEOUT_MS)
    this.timer.unref?.()
  }

  get isOpen(): boolean {
    return this.state === 'open'
  }

  close(): void {
    this.pipe.close(1000, '')
    this.closed()
  }

  private load(): number {
    return this.sealing + (this.pipe.buffered?.() ?? 0)
  }

  private drained(): Promise<void> {
    return new Promise((resolve) => {
      const tick = (): void => {
        if (this.state === 'closed' || this.load() <= SEND_LOW_BYTES) return resolve()
        setTimeout(tick, DRAIN_POLL_MS).unref?.()
      }
      tick()
    })
  }

  private post(msg: Record<string, unknown>, size = 0): void {
    const channel = this.channel
    if (!channel || (this.state !== 'open' && msg.t !== 'welcome' && msg.t !== 'denied')) return
    this.sealing += size
    void channel.seal(msg).then((frame) => {
      this.sealing -= size
      this.pipe.send(frame)
    }, () => {
      this.sealing -= size
      this.abort('加密失败')
    })
  }

  private abort(reason: string): void {
    if (this.state === 'closed') return
    this.hooks.log?.(`中继连接断开：${reason}`)
    this.pipe.close(4400, 'protocol')
    this.closed()
  }

  private closed(): void {
    if (this.state === 'closed') return
    const wasOpen = this.state === 'open'
    this.state = 'closed'
    clearTimeout(this.timer)
    for (const p of this.pending.values()) {
      p.finish?.()
      p.req.destroy()
    }
    this.pending.clear()
    if (wasOpen) this.hooks.onClose?.(this)
  }

  private async handle(text: string): Promise<void> {
    if (this.state === 'closed') return
    if (text.length > SEALED_FRAME_MAX) throw new Error('frame too large')
    if (this.state === 'hello') return this.hello(text)
    const msg = (await this.channel!.open(text)) as Record<string, unknown>
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) throw new Error('消息格式不对')
    if (this.state === 'auth') return this.auth(msg)
    await this.frame(msg)
  }

  private async hello(text: string): Promise<void> {
    if (text.length > HANDSHAKE_FRAME_MAX) throw new Error('handshake frame too large')
    const msg = JSON.parse(text) as { t?: unknown; v?: unknown; x?: unknown; c?: unknown; e?: unknown }
    if (msg.t !== 'hi' || msg.v !== RELAY_PROTOCOL_VERSION || typeof msg.c !== 'string' || typeof msg.e !== 'string') throw new Error('握手消息不对')
    this.version = typeof msg.x === 'number' && msg.x >= TEXT_PROTOCOL ? TEXT_PROTOCOL : RELAY_PROTOCOL_VERSION
    const serverEph = await generateKeyPair()
    this.channel = await serverSession({ serverStatic: this.hooks.hostKey, serverEph, clientStaticRaw: fromB64u(msg.c), clientEphRaw: fromB64u(msg.e) })
    this.clientKey = msg.c
    this.state = 'auth'
    this.pipe.send(JSON.stringify({ t: 'hi', v: this.version, e: toB64u(serverEph.raw) }))
  }

  private async auth(msg: Record<string, unknown>): Promise<void> {
    if (msg.t !== 'auth') throw new Error('应先认证')
    const result = await this.hooks.authenticate(this.clientKey, typeof msg.name === 'string' ? msg.name : '', typeof msg.pair === 'string' ? msg.pair : undefined, declaredKind(msg.kind))
    if (!result.ok) {
      this.post({ t: 'denied', reason: result.reason })
      this.hooks.log?.(`中继设备认证失败：${result.reason}`)
      setTimeout(() => this.close(), 200).unref?.()
      this.state = 'closed'
      clearTimeout(this.timer)
      return
    }
    this.client = result.client
    this.state = 'open'
    clearTimeout(this.timer)
    this.post({ t: 'welcome', kind: result.client.kind, name: result.client.name })
    this.hooks.onOpen?.(this)
  }

  private frame(msg: Record<string, unknown>): void | Promise<void> {
    if (msg.t === 'ping') return this.post({ t: 'pong' })
    if (msg.t === 'abort' && typeof msg.id === 'string') {
      const pending = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      pending?.finish?.()
      pending?.req.destroy()
      return
    }
    if (msg.t === 'req') return void this.request(msg)
  }

  private fail(id: string, status: number, error: string): void {
    const text = JSON.stringify({ ok: false, error })
    this.post({ t: 'res', id, status, headers: { 'content-type': 'application/json; charset=utf-8' }, ...(this.version >= TEXT_PROTOCOL ? { text } : { body: Buffer.from(text).toString('base64') }) })
  }

  private request(msg: Record<string, unknown>): void {
    const id = typeof msg.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(msg.id) ? msg.id : null
    if (!id) return
    if (this.pending.has(id)) return this.fail(id, 400, pick('请求 id 重复', 'Duplicate request id'))
    const method = msg.method === 'GET' || msg.method === 'POST' ? msg.method : null
    const path = typeof msg.path === 'string' ? msg.path : ''
    let url: URL
    try {
      url = new URL(path, 'http://relay.local')
    } catch {
      return this.fail(id, 400, pick('路径无效', 'Invalid path'))
    }
    if (!method || !path.startsWith('/') || url.origin !== 'http://relay.local' || !url.pathname.startsWith('/remote/v1/') || url.pathname.includes('..')) {
      return this.fail(id, 403, pick('经中继只能访问砚的远程接口', 'Only the Inkstone remote API is reachable through the relay'))
    }
    const kind = this.client?.kind ?? 'phone'
    if (kind === 'agent' && !AGENT_PATHS.has(url.pathname)) return this.fail(id, 403, pick('Agent Hub 已退役，礁石不能再使用远程接口', 'Agent Hub is retired; the remote API is no longer available'))
    if (msg.stream === 'in') return this.fail(id, 400, pick('这个请求不支持流式上传', 'This request does not accept a streamed upload'))
    if (this.pending.size >= MAX_REQUESTS) return this.fail(id, 429, pick('同时进行的请求太多', 'Too many concurrent requests'))
    const target = this.hooks.target()
    if (!target) return this.fail(id, 503, pick('电脑上的远程服务没有运行', 'The remote service on the computer is not running'))

    const body = typeof msg.body === 'string' ? msg.body : ''
    const bodyText = typeof msg.text === 'string' ? msg.text : null
    const maxBytes = method !== 'POST' ? null
      : url.pathname === '/remote/v1/voice/transcribe' ? VOICE_MAX_BODY_BYTES
        : /^\/remote\/v1\/sessions\/[^/]+\/messages$/.test(url.pathname) ? REMOTE_MESSAGE_MAX_BYTES : null
    const limit = maxBytes === null ? MAX_BODY_B64 : 4 * Math.ceil(maxBytes / 3)
    if (bodyText !== null ? Buffer.byteLength(bodyText) > (maxBytes ?? MAX_BODY_B64) : body.length > limit) return this.fail(id, 413, pick('请求太大', 'Request too large'))
    let payload = bodyText !== null ? Buffer.from(bodyText, 'utf8') : body ? Buffer.from(body, 'base64') : Buffer.alloc(0)
    if (maxBytes !== null && payload.length > maxBytes) return this.fail(id, 413, pick('请求太大', 'Request too large'))
    const given = msg.headers && typeof msg.headers === 'object' ? (msg.headers as Record<string, unknown>) : {}
    const headers: Record<string, string> = {}
    for (const name of FORWARD_HEADERS) {
      const value = given[name] ?? given[name.toLowerCase()]
      if (typeof value === 'string' && value.length <= 4096 && !/[\r\n]/.test(value)) headers[name] = value
    }
    if (url.pathname === '/remote/v1/pair' && method === 'POST') {
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(payload.toString('utf8') || '{}') as Record<string, unknown>
      } catch {
        return this.fail(id, 400, pick('配对请求格式不对', 'Invalid pairing request'))
      }
      payload = Buffer.from(JSON.stringify({ ...parsed, kind }))
      headers['content-type'] = 'application/json'
    }
    headers['x-yan-relay'] = target.relayToken
    headers['x-yan-relay-kind'] = kind
    if (this.client) headers['x-yan-relay-client'] = this.client.id
    if (payload.length) headers['content-length'] = String(payload.length)

    const req = httpRequest({ host: target.host, port: target.port, method, path: `${url.pathname}${url.search}`, headers, timeout: REQUEST_TIMEOUT_MS }, (res) => {
      const entry = this.pending.get(id)
      if (!entry || entry.req !== req) {
        res.destroy()
        return
      }
      const status = res.statusCode ?? 502
      const resHeaders: Record<string, string> = {}
      for (const name of ['content-type', 'cache-control', 'content-disposition', 'x-yan-idempotent-replay']) {
        const v = res.headers[name]
        if (typeof v === 'string') resHeaders[name] = v
      }
      const streaming = (resHeaders['content-type'] ?? '').startsWith('text/event-stream')
      const asText = this.version >= TEXT_PROTOCOL && textual(resHeaders['content-type'])
      const decoder = asText ? new StringDecoder('utf8') : null
      const chunk = (bytes: Buffer, last = false): void => {
        if (!decoder) {
          if (bytes.length) this.post({ t: 'chunk', id, data: bytes.toString('base64') }, bytes.length)
          return
        }
        const text = decoder.write(bytes) + (last ? decoder.end() : '')
        if (text) this.post({ t: 'chunk', id, text }, bytes.length)
      }
      entry.stream = streaming
      if (streaming && [...this.pending.values()].filter((p) => p.stream).length > MAX_STREAMS) {
        res.destroy()
        this.pending.delete(id)
        return this.fail(id, 429, pick('同时打开的事件流太多', 'Too many open event streams'))
      }
      if (streaming) {
        this.post({ t: 'res', id, status, headers: resHeaders, stream: true })
        let buf: Buffer[] = []
        let timer: ReturnType<typeof setTimeout> | undefined
        let finished = false
        const finish = (error?: string, discard = false) => {
          if (finished) return
          finished = true
          if (timer) clearTimeout(timer)
          if (this.pending.get(id) === entry) {
            if (!discard) {
              flush()
              if (decoder) chunk(Buffer.alloc(0), true)
            }
            this.pending.delete(id)
            this.post({ t: 'end', id, ...(error ? { error } : {}) })
          }
          buf = []
        }
        const overflow = () => {
          finish(pick('事件流发送积压，请重新连接并用 last-event-id 续传', 'Event stream backlog; reconnect and resume with last-event-id'), true)
          req.destroy()
        }
        const flush = () => {
          timer = undefined
          if (!buf.length || finished) return
          if (this.load() > STREAM_BACKLOG_BYTES) return overflow()
          chunk(Buffer.concat(buf))
          buf = []
        }
        entry.finish = finish
        res.on('data', (c: Buffer) => {
          if (finished) return
          buf.push(c)
          if (this.load() > STREAM_BACKLOG_BYTES) return overflow()
          timer ??= setTimeout(flush, COALESCE_MS)
        })
        res.on('end', () => finish())
        res.on('error', () => finish(STREAM_BROKEN()))
        res.on('aborted', () => finish(STREAM_BROKEN()))
        res.on('close', () => finish(STREAM_BROKEN()))
        return
      }
      let held: Buffer[] = []
      let heldBytes = 0
      let started = false
      let finished = false
      let paused = false
      const declared = Number(res.headers['content-length'])
      const begin = (): void => {
        started = true
        this.post({ t: 'res', id, status, headers: resHeaders, stream: true })
      }
      const sendHeld = (final: boolean): void => {
        if (!heldBytes && !final) return
        const all = held.length === 1 ? held[0] : Buffer.concat(held)
        let off = 0
        while (all.length - off >= CHUNK) {
          chunk(all.subarray(off, off + CHUNK))
          off += CHUNK
        }
        const tail = all.subarray(off)
        if (final) {
          chunk(tail, true)
          held = []
          heldBytes = 0
        } else {
          held = tail.length ? [tail] : []
          heldBytes = tail.length
        }
      }
      const finishBody = (error?: string): void => {
        if (finished) return
        finished = true
        if (this.pending.get(id) !== entry) {
          held = []
          return
        }
        this.pending.delete(id)
        if (!started) {
          if (error) {
            held = []
            return this.fail(id, 502, pick('电脑上的远程服务没有响应', 'The remote service on the computer is not responding'))
          }
          const all = held.length === 1 ? held[0] : Buffer.concat(held)
          held = []
          this.post({ t: 'res', id, status, headers: resHeaders, ...(!all.length ? {} : asText ? { text: all.toString('utf8') } : { body: all.toString('base64') }) }, all.length)
          return
        }
        if (!error) sendHeld(true)
        held = []
        this.post({ t: 'end', id, ...(error ? { error } : {}) })
      }
      entry.finish = (error) => {
        if (error) finishBody(error)
        else {
          finished = true
          held = []
        }
      }
      if (Number.isFinite(declared) && declared > INLINE_RESPONSE) begin()
      res.on('data', (c: Buffer) => {
        if (finished) return
        held.push(c)
        heldBytes += c.length
        if (!started) {
          if (heldBytes <= INLINE_RESPONSE) return
          begin()
        }
        if (heldBytes >= CHUNK) sendHeld(false)
        if (paused || this.load() <= SEND_HIGH_BYTES) return
        paused = true
        res.pause()
        void this.drained().then(() => {
          paused = false
          if (!finished) res.resume()
        })
      })
      res.on('end', () => finishBody())
      res.on('error', () => finishBody(BODY_BROKEN()))
      res.on('aborted', () => finishBody(BODY_BROKEN()))
      res.on('close', () => finishBody(BODY_BROKEN()))
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', () => {
      const entry = this.pending.get(id)
      if (!entry || entry.req !== req) return
      if (entry.finish) return entry.finish(entry.stream ? STREAM_BROKEN() : BODY_BROKEN())
      this.pending.delete(id)
      this.fail(id, 502, pick('电脑上的远程服务没有响应', 'The remote service on the computer is not responding'))
    })
    this.pending.set(id, { req, stream: false })
    req.end(payload)
  }
}
