import { WebSocket } from 'ws'
import { clientSession, fromB64u, generateKeyPair, toB64u, type KeyPair, type SecureChannel } from './relay-bridge/crypto'
import { pick } from '../shared/ui-lang'

const PROTOCOL_VERSION = 1
const TEXT_PROTOCOL = 2
const HANDSHAKE_MS = 15_000
const JSON_MAX_BYTES = 16 * 1024 * 1024
const MAX_FRAME_BYTES = 24 * 1024 * 1024
const HANDSHAKE_FRAME_MAX = 4096
const PING_MS = 25_000

export interface TunnelReply {
  status: number
  text: string
}

export class WatchTunnelError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'WatchTunnelError'
  }
}

type Pending = {
  resolve(value: TunnelReply): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout> | null
  chunks: string[]
  bytes: number
  status: number
  stream?: { opened(status: number): void; chunk(text: string): void; end(error?: Error): void }
}

export interface WatchTunnelConfig {
  url: string
  hostKey: string
  deviceName: string
  pairingCode: string
  onClose?(error: Error): void
}

export class WatchTunnel {
  private ws: WebSocket | null = null
  private channel: SecureChannel | null = null
  private ready: Promise<void> | null = null
  private dead = false
  private seq = 0
  private ping: ReturnType<typeof setInterval> | null = null
  private readonly pending = new Map<string, Pending>()
  private readonly decoder = new TextDecoder()

  constructor(private readonly config: WatchTunnelConfig) {}

  get connected(): boolean {
    return !!this.ws && this.channel !== null && !this.dead
  }

  connect(): Promise<void> {
    if (this.dead) return Promise.reject(new WatchTunnelError(pick('\u8fde\u63a5\u5df2\u5173\u95ed', 'This connection is closed'), 'tunnel-closed'))
    this.ready ??= this.handshake().catch((error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error))
      this.reset(failure)
      throw failure
    })
    return this.ready
  }

  private async handshake(): Promise<void> {
    const clientStatic: KeyPair = await generateKeyPair()
    const clientEph = await generateKeyPair()
    const ws = new WebSocket(this.config.url, { handshakeTimeout: HANDSHAKE_MS, perMessageDeflate: false, maxPayload: MAX_FRAME_BYTES })
    this.ws = ws
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => fail(new WatchTunnelError(pick('\u8fde\u63a5\u5bf9\u65b9\u7535\u8111\u8d85\u65f6', 'Timed out connecting to the host'), 'tunnel-timeout')), HANDSHAKE_MS)
      timer.unref?.()
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try {
          ws.terminate()
        } catch {
        }
        reject(error)
      }
      const fatal = (error: Error): void => {
        if (!settled) return fail(error)
        try {
          ws.terminate()
        } catch {
        }
        this.reset(error)
      }
      ws.on('open', () => {
        ws.send(JSON.stringify({ t: 'hi', v: PROTOCOL_VERSION, x: TEXT_PROTOCOL, c: toB64u(clientStatic.raw), e: toB64u(clientEph.raw) }))
      })
      ws.on('error', () => fail(new WatchTunnelError(pick('\u8fde\u4e0d\u4e0a\u5bf9\u65b9\u7535\u8111', 'Could not reach the host'), 'tunnel-unreachable')))
      ws.on('close', (code) => {
        const error = new WatchTunnelError(pick(`\u4e0e\u5bf9\u65b9\u7535\u8111\u7684\u8fde\u63a5\u65ad\u5f00\u4e86\uff08${code}\uff09`, `The connection to the host closed (${code})`), 'tunnel-closed')
        if (!settled) return fail(error)
        this.reset(error)
      })
      ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], binary: boolean) => {
        if (binary) return fatal(new WatchTunnelError(pick('\u5bf9\u65b9\u53d1\u6765\u4e86\u4e8c\u8fdb\u5236\u5e27', 'The host sent a binary frame'), 'tunnel-protocol'))
        const text = Buffer.isBuffer(data) ? data.toString('utf8') : Array.isArray(data) ? Buffer.concat(data).toString('utf8') : Buffer.from(data).toString('utf8')
        if (!this.channel) {
          if (text.length > HANDSHAKE_FRAME_MAX) return fail(new WatchTunnelError(pick('\u5bf9\u65b9\u7684\u63e1\u624b\u6d88\u606f\u592a\u5927', 'The handshake from the host is too large'), 'tunnel-protocol'))
          let hi: { t?: unknown; e?: unknown }
          try {
            hi = JSON.parse(text) as typeof hi
          } catch {
            return fail(new WatchTunnelError(pick('\u5bf9\u65b9\u7684\u63e1\u624b\u6d88\u606f\u4e0d\u5bf9', 'Invalid handshake from the host'), 'tunnel-protocol'))
          }
          if (hi.t !== 'hi' || typeof hi.e !== 'string') return fail(new WatchTunnelError(pick('\u5bf9\u65b9\u7684\u63e1\u624b\u6d88\u606f\u4e0d\u5bf9', 'Invalid handshake from the host'), 'tunnel-protocol'))
          void clientSession({ clientStatic, clientEph, serverStaticRaw: fromB64u(this.config.hostKey), serverEphRaw: fromB64u(hi.e) })
            .then((channel) => {
              this.channel = channel
              return channel.seal({ t: 'auth', name: this.config.deviceName, kind: 'viewer', pair: this.config.pairingCode })
            })
            .then((frame) => ws.send(frame), (error: unknown) => fatal(error instanceof Error ? error : new Error(String(error))))
          return
        }
        void this.channel.open(text).then((message) => {
          const msg = message as Record<string, unknown>
          if (!settled) {
            if (msg.t === 'denied') return fail(new WatchTunnelError(typeof msg.reason === 'string' ? msg.reason : pick('\u5bf9\u65b9\u62d2\u7edd\u4e86\u8fde\u63a5', 'The host refused this connection'), 'tunnel-denied'))
            if (msg.t !== 'welcome') return fail(new WatchTunnelError(pick('\u5bf9\u65b9\u7684\u56de\u5e94\u4e0d\u5bf9', 'Invalid response from the host'), 'tunnel-protocol'))
            settled = true
            clearTimeout(timer)
            this.ping = setInterval(() => this.send({ t: 'ping' }), PING_MS)
            this.ping.unref?.()
            resolve()
            return
          }
          this.frame(msg)
        }, () => fatal(new WatchTunnelError(pick('\u5bf9\u65b9\u53d1\u6765\u7684\u52a0\u5bc6\u5e27\u6253\u4e0d\u5f00\uff0c\u9080\u8bf7\u53ef\u80fd\u4e0d\u662f\u8fd9\u53f0\u7535\u8111\u53d1\u7684', 'An encrypted frame could not be opened; the invite may not belong to this host'), 'tunnel-protocol')))
      })
    })
  }

  private reset(reason: Error): void {
    if (this.dead) return
    this.dead = true
    if (this.ping) clearInterval(this.ping)
    this.ping = null
    this.ws = null
    this.channel = null
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer)
      if (pending.stream) pending.stream.end(reason)
      pending.reject(reason)
    }
    this.pending.clear()
    this.config.onClose?.(reason)
  }

  close(): void {
    const ws = this.ws
    try {
      ws?.close()
    } catch {
    }
    this.reset(new WatchTunnelError(pick('\u8fde\u63a5\u5df2\u5173\u95ed', 'This connection is closed'), 'tunnel-closed'))
  }

  private chunkText(msg: Record<string, unknown>): string {
    if (typeof msg.text === 'string') return msg.text
    if (typeof msg.data === 'string') return this.decoder.decode(Buffer.from(msg.data, 'base64'))
    if (typeof msg.body === 'string') return this.decoder.decode(Buffer.from(msg.body, 'base64'))
    return ''
  }

  private frame(msg: Record<string, unknown>): void {
    const id = typeof msg.id === 'string' ? msg.id : ''
    const pending = this.pending.get(id)
    if (!pending) return
    if (msg.t === 'res') {
      pending.status = Number(msg.status) || 502
      if (pending.stream) {
        pending.stream.opened(pending.status)
        const first = this.chunkText(msg)
        if (first) pending.stream.chunk(first)
        if (!msg.stream) {
          this.pending.delete(id)
          pending.stream.end()
        }
        return
      }
      if (msg.stream) return
      this.finish(id, pending, this.chunkText(msg))
      return
    }
    if (msg.t === 'chunk') {
      const text = this.chunkText(msg)
      if (!text) return
      if (pending.stream) return pending.stream.chunk(text)
      pending.bytes += text.length
      if (pending.bytes > JSON_MAX_BYTES) {
        this.pending.delete(id)
        if (pending.timer) clearTimeout(pending.timer)
        this.send({ t: 'abort', id })
        pending.reject(new WatchTunnelError(pick('\u5bf9\u65b9\u8fd4\u56de\u7684\u5185\u5bb9\u592a\u5927', 'The host returned too much data'), 'response-too-large'))
        return
      }
      pending.chunks.push(text)
      return
    }
    if (msg.t === 'end') {
      const error = typeof msg.error === 'string' && msg.error ? new WatchTunnelError(msg.error, 'response-failed') : undefined
      if (pending.stream) {
        this.pending.delete(id)
        pending.stream.end(error)
        return
      }
      if (error) {
        this.pending.delete(id)
        if (pending.timer) clearTimeout(pending.timer)
        pending.reject(error)
        return
      }
      this.finish(id, pending, pending.chunks.join(''))
    }
  }

  private finish(id: string, pending: Pending, text: string): void {
    this.pending.delete(id)
    if (pending.timer) clearTimeout(pending.timer)
    pending.resolve({ status: pending.status, text })
  }

  private send(frame: Record<string, unknown>): void {
    const channel = this.channel
    if (!channel) return
    void channel.seal(frame).then((text) => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(text)
    }, () => undefined)
  }

  async request(method: 'GET' | 'POST', path: string, options: { token?: string; body?: unknown; timeoutMs?: number } = {}): Promise<TunnelReply> {
    await this.connect()
    const id = `p${++this.seq}`
    const promise = new Promise<TunnelReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.send({ t: 'abort', id })
        reject(new WatchTunnelError(pick('\u5bf9\u65b9\u7535\u8111\u6ca1\u6709\u53ca\u65f6\u56de\u5e94', 'The host did not answer in time'), 'tunnel-timeout'))
      }, options.timeoutMs ?? 30_000)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer, chunks: [], bytes: 0, status: 0 })
    })
    this.send({
      t: 'req',
      id,
      method,
      path,
      headers: {
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' })
      },
      ...(options.body === undefined ? {} : { text: JSON.stringify(options.body) })
    })
    return promise
  }

  async openStream(path: string, token: string, handlers: { chunk(text: string): void; end(error?: Error): void }): Promise<{ ok: true; stop: () => void } | { ok: false; status: number; error: string }> {
    await this.connect()
    const id = `s${++this.seq}`
    return new Promise((settle) => {
      let opened = false
      let ended = false
      let status = 0
      const stop = (): void => {
        ended = true
        if (!this.pending.delete(id)) return
        this.send({ t: 'abort', id })
      }
      const errorText: string[] = []
      this.pending.set(id, {
        resolve: () => undefined,
        reject: (error) => {
          if (!opened) settle({ ok: false, status: 0, error: error.message })
        },
        timer: null,
        chunks: [],
        bytes: 0,
        status: 0,
        stream: {
          opened: (code) => {
            status = code
            if (code >= 200 && code < 300) {
              opened = true
              settle({ ok: true, stop })
            }
          },
          chunk: (text) => {
            if (opened) {
              if (!ended) handlers.chunk(text)
            } else errorText.push(text)
          },
          end: (error) => {
            if (!opened) {
              settle({ ok: false, status, error: errorText.join('') || error?.message || '' })
              return
            }
            if (ended) return
            ended = true
            handlers.end(error)
          }
        }
      })
      this.send({ t: 'req', id, method: 'GET', path, headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' } })
    })
  }
}
