/**
 * 中继里一个客户端（手机或礁石）的会话：先完成与礁石 App 相同的握手和设备认证，
 * 之后把加密的「HTTP 请求帧」转给砚本机的远程服务（专用的 127.0.0.1 实例），响应与 SSE 分帧传回。
 *
 * 边界：只转发 `/remote/v1/` 路径与白名单请求头；礁石（agent）只能用 Hub 相关路径；
 * 配对请求里的设备类型由中继配对时的用途决定，客户端不能自己改。帧格式见礁石仓库 docs/specs/hub-relay.md。
 */
import { request as httpRequest, type ClientRequest } from 'node:http'
import { fromB64u, generateKeyPair, RELAY_PROTOCOL_VERSION, serverSession, toB64u, type KeyPair, type SecureChannel } from './crypto'
import type { RelayClient } from './store'
import { REMOTE_IDEMPOTENCY_HEADER } from '../../shared/remote-protocol'

export interface Pipe {
  send(text: string): void
  close(code?: number, reason?: string): void
  onmessage?: (text: string) => void
  onclose?: () => void
}

export interface TunnelTarget {
  host: string
  port: number
  /** 只有隧道知道的标记：本机服务据此确认请求来自中继隧道（用于 agent 配对）。 */
  relayToken: string
}

export interface TunnelHooks {
  hostKey: KeyPair
  authenticate(clientKey: string, name: string, pair: string | undefined): Promise<{ ok: true; client: RelayClient } | { ok: false; reason: string }>
  target(): TunnelTarget | null
  onOpen?(session: TunnelSession): void
  onClose?(session: TunnelSession): void
  log?(text: string): void
}

const HANDSHAKE_TIMEOUT_MS = 10_000
const MAX_BODY_B64 = 1_200_000 // ≈ 900 KB
const INLINE_RESPONSE = 600 * 1024
const CHUNK = 512 * 1024
const MAX_REQUESTS = 16
const MAX_STREAMS = 4
const COALESCE_MS = 50
const REQUEST_TIMEOUT_MS = 120_000
const FORWARD_HEADERS = ['authorization', 'content-type', 'x-yan-remote-token', REMOTE_IDEMPOTENCY_HEADER, 'last-event-id', 'accept']
/** 礁石（agent）只能碰这些路径；其余由本机服务按设备类型再拦一次。 */
const AGENT_PATHS = new Set(['/remote/v1/health', '/remote/v1/info', '/remote/v1/pair', '/remote/v1/hub', '/remote/v1/hub/attention'])

type Pending = { req: ClientRequest; stream: boolean }

export class TunnelSession {
  private state: 'hello' | 'auth' | 'open' | 'closed' = 'hello'
  private channel: SecureChannel | undefined
  private clientKey = ''
  private chain: Promise<void> = Promise.resolve()
  private readonly timer: ReturnType<typeof setTimeout>
  private readonly pending = new Map<string, Pending>()
  client: RelayClient | null = null

  constructor(readonly pipe: Pipe, private readonly hooks: TunnelHooks) {
    pipe.onmessage = (text) => {
      this.chain = this.chain.then(() => this.handle(text)).catch((error: unknown) => this.abort(error instanceof Error ? error.message : String(error)))
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

  private post(msg: Record<string, unknown>): void {
    const channel = this.channel
    if (!channel || (this.state !== 'open' && msg.t !== 'welcome' && msg.t !== 'denied')) return
    void channel.seal(msg).then((frame) => this.pipe.send(frame), () => this.abort('加密失败'))
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
    for (const p of this.pending.values()) p.req.destroy()
    this.pending.clear()
    if (wasOpen) this.hooks.onClose?.(this)
  }

  private async handle(text: string): Promise<void> {
    if (this.state === 'closed') return
    if (this.state === 'hello') return this.hello(text)
    const msg = (await this.channel!.open(text)) as Record<string, unknown>
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) throw new Error('消息格式不对')
    if (this.state === 'auth') return this.auth(msg)
    this.frame(msg)
  }

  private async hello(text: string): Promise<void> {
    const msg = JSON.parse(text) as { t?: unknown; v?: unknown; c?: unknown; e?: unknown }
    if (msg.t !== 'hi' || msg.v !== RELAY_PROTOCOL_VERSION || typeof msg.c !== 'string' || typeof msg.e !== 'string') throw new Error('握手消息不对')
    const serverEph = await generateKeyPair()
    this.channel = await serverSession({ serverStatic: this.hooks.hostKey, serverEph, clientStaticRaw: fromB64u(msg.c), clientEphRaw: fromB64u(msg.e) })
    this.clientKey = msg.c
    this.state = 'auth'
    this.pipe.send(JSON.stringify({ t: 'hi', v: RELAY_PROTOCOL_VERSION, e: toB64u(serverEph.raw) }))
  }

  private async auth(msg: Record<string, unknown>): Promise<void> {
    if (msg.t !== 'auth') throw new Error('应先认证')
    const result = await this.hooks.authenticate(this.clientKey, typeof msg.name === 'string' ? msg.name : '', typeof msg.pair === 'string' ? msg.pair : undefined)
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

  private frame(msg: Record<string, unknown>): void {
    if (msg.t === 'ping') return this.post({ t: 'pong' })
    if (msg.t === 'abort' && typeof msg.id === 'string') {
      this.pending.get(msg.id)?.req.destroy()
      this.pending.delete(msg.id)
      return
    }
    if (msg.t === 'req') return this.request(msg)
  }

  private fail(id: string, status: number, error: string): void {
    this.post({ t: 'res', id, status, headers: { 'content-type': 'application/json; charset=utf-8' }, body: Buffer.from(JSON.stringify({ ok: false, error })).toString('base64') })
  }

  private request(msg: Record<string, unknown>): void {
    const id = typeof msg.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(msg.id) ? msg.id : null
    if (!id) return
    if (this.pending.has(id)) return this.fail(id, 400, '请求 id 重复')
    const method = msg.method === 'GET' || msg.method === 'POST' ? msg.method : null
    const path = typeof msg.path === 'string' ? msg.path : ''
    let url: URL
    try {
      url = new URL(path, 'http://relay.local')
    } catch {
      return this.fail(id, 400, '路径无效')
    }
    if (!method || !path.startsWith('/') || url.origin !== 'http://relay.local' || !url.pathname.startsWith('/remote/v1/') || url.pathname.includes('..')) {
      return this.fail(id, 403, '经中继只能访问砚的远程接口')
    }
    const kind = this.client?.kind ?? 'phone'
    if (kind === 'agent' && !AGENT_PATHS.has(url.pathname)) return this.fail(id, 403, '礁石只能使用 Agent Hub 接口')
    if (this.pending.size >= MAX_REQUESTS) return this.fail(id, 429, '同时进行的请求太多')
    const target = this.hooks.target()
    if (!target) return this.fail(id, 503, '电脑上的远程服务没有运行')

    const body = typeof msg.body === 'string' ? msg.body : ''
    if (body.length > MAX_BODY_B64) return this.fail(id, 413, '请求太大')
    let payload = body ? Buffer.from(body, 'base64') : Buffer.alloc(0)
    const given = msg.headers && typeof msg.headers === 'object' ? (msg.headers as Record<string, unknown>) : {}
    const headers: Record<string, string> = {}
    for (const name of FORWARD_HEADERS) {
      const value = given[name] ?? given[name.toLowerCase()]
      if (typeof value === 'string' && value.length <= 4096 && !/[\r\n]/.test(value)) headers[name] = value
    }
    // 配对的设备类型由中继配对用途决定：礁石只能成为 agent，手机只能成为 phone。
    if (url.pathname === '/remote/v1/pair' && method === 'POST') {
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(payload.toString('utf8') || '{}') as Record<string, unknown>
      } catch {
        return this.fail(id, 400, '配对请求格式不对')
      }
      payload = Buffer.from(JSON.stringify({ ...parsed, kind: kind === 'agent' ? 'agent' : 'phone' }))
      headers['content-type'] = 'application/json'
    }
    headers['x-yan-relay'] = target.relayToken
    headers['x-yan-relay-kind'] = kind
    if (payload.length) headers['content-length'] = String(payload.length)

    const req = httpRequest({ host: target.host, port: target.port, method, path: `${url.pathname}${url.search}`, headers, timeout: REQUEST_TIMEOUT_MS }, (res) => {
      const status = res.statusCode ?? 502
      const resHeaders: Record<string, string> = {}
      for (const name of ['content-type', 'cache-control', 'content-disposition', 'x-yan-idempotent-replay']) {
        const v = res.headers[name]
        if (typeof v === 'string') resHeaders[name] = v
      }
      const streaming = (resHeaders['content-type'] ?? '').startsWith('text/event-stream')
      const entry = this.pending.get(id)
      if (entry) entry.stream = streaming
      if (streaming && [...this.pending.values()].filter((p) => p.stream).length > MAX_STREAMS) {
        res.destroy()
        this.pending.delete(id)
        return this.fail(id, 429, '同时打开的事件流太多')
      }
      if (streaming) {
        this.post({ t: 'res', id, status, headers: resHeaders, stream: true })
        let buf: Buffer[] = []
        let timer: ReturnType<typeof setTimeout> | undefined
        const flush = () => {
          timer = undefined
          if (!buf.length) return
          this.post({ t: 'chunk', id, data: Buffer.concat(buf).toString('base64') })
          buf = []
        }
        res.on('data', (c: Buffer) => {
          buf.push(c)
          timer ??= setTimeout(flush, COALESCE_MS)
        })
        res.on('end', () => {
          if (timer) clearTimeout(timer)
          flush()
          this.post({ t: 'end', id })
          this.pending.delete(id)
        })
        res.on('error', () => this.pending.delete(id))
        return
      }
      const parts: Buffer[] = []
      res.on('data', (c: Buffer) => parts.push(c))
      res.on('end', () => {
        this.pending.delete(id)
        const all = Buffer.concat(parts)
        if (all.length <= INLINE_RESPONSE) {
          this.post({ t: 'res', id, status, headers: resHeaders, ...(all.length ? { body: all.toString('base64') } : {}) })
          return
        }
        // 大响应（如成果文件）分块传回。
        this.post({ t: 'res', id, status, headers: resHeaders, stream: true })
        for (let off = 0; off < all.length; off += CHUNK) this.post({ t: 'chunk', id, data: all.subarray(off, off + CHUNK).toString('base64') })
        this.post({ t: 'end', id })
      })
      res.on('error', () => this.pending.delete(id))
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', () => {
      if (!this.pending.has(id)) return
      this.pending.delete(id)
      this.fail(id, 502, '电脑上的远程服务没有响应')
    })
    this.pending.set(id, { req, stream: false })
    req.end(payload)
  }
}
