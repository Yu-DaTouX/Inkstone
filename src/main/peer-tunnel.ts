import { closeSync, openSync, writeSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { clientSession, exportKeyPair, fromB64u, generateKeyPair, importKeyPair, toB64u, type SecureChannel } from './relay-bridge/crypto'
import { pick } from '../shared/ui-lang'

const PROTOCOL_VERSION = 1
const TEXT_PROTOCOL = 2
const HANDSHAKE_MS = 15_000
const UPLOAD_CHUNK = 512 * 1024
const JSON_MAX_BYTES = 16 * 1024 * 1024
const MAX_FRAME_BYTES = 2 * 1024 * 1024
const HANDSHAKE_FRAME_MAX = 4096
const WS_OPEN = 1

interface WsClient {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  terminate(): void
  on(event: 'open', listener: () => void): void
  on(event: 'message', listener: (data: Buffer | string, binary: boolean) => void): void
  on(event: 'close', listener: (code: number) => void): void
  on(event: 'error', listener: (error: Error) => void): void
}

type WsCtor = new (url: string, options: { handshakeTimeout?: number; perMessageDeflate?: boolean; maxPayload?: number }) => WsClient

let wsCtor: WsCtor | null = null

async function loadWebSocket(): Promise<WsCtor> {
  if (wsCtor) return wsCtor
  try {
    const module = await import('ws')
    wsCtor = module.WebSocket as unknown as WsCtor
    return wsCtor
  } catch {
  }
  const fallback = (globalThis as unknown as { WebSocket?: WsCtor }).WebSocket
  if (!fallback || typeof fallback.prototype?.on !== 'function') {
    throw new PeerTunnelError(pick('本机没有可用的 WebSocket 实现', 'No WebSocket implementation is available'), 'ws-missing')
  }
  wsCtor = fallback
  return wsCtor
}

export interface PeerTunnelKeys {
  publicKey: string
  privateJwk: unknown
}

export interface TunnelReply {
  status: number
  headers: Record<string, string>
  text: string
  bytes: number
  body: Buffer
}

export async function newPeerTunnelKeys(): Promise<PeerTunnelKeys> {
  const pair = await generateKeyPair()
  return { publicKey: toB64u(pair.raw), privateJwk: await exportKeyPair(pair) }
}

export function tunnelUrlFor(address: string): string {
  const match = /^(https?):\/\/([^\s/]+)\/?$/i.exec(address.trim())
  if (!match) throw new Error(pick('电脑地址格式不对', 'That desktop address is not valid'))
  return `${match[1].toLowerCase() === 'https' ? 'wss' : 'ws'}://${match[2]}/remote/v1/tunnel`
}

type Pending = {
  resolve(value: TunnelReply): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
  chunks: Buffer[]
  bytes: number
  maxBytes: number
  status: number
  headers: Record<string, string>
  stream: boolean
  file: { fd: number } | null
  onStart?(status: number): void
  onEnd?(error?: Error): void
  open?(status: number): void
}

export class PeerTunnelError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message)
    this.name = 'PeerTunnelError'
  }
}

export class PeerTunnel {
  private ws: WsClient | null = null
  private channel: SecureChannel | null = null
  private ready: Promise<void> | null = null
  private dead = false
  private seq = 0
  private readonly pending = new Map<string, Pending>()

  constructor(private readonly config: { url: string; hostKey: string; keys: PeerTunnelKeys; deviceName: string; pairingCode?: string }) {}

  get connected(): boolean {
    return !!this.ws && this.channel !== null && !this.dead
  }

  connect(): Promise<void> {
    if (this.dead) return Promise.reject(new PeerTunnelError(pick('连接已关闭', 'This connection is closed'), 'tunnel-closed'))
    if (this.ready) return this.ready
    const ready = this.handshake()
    this.ready = ready.catch((error: unknown) => {
      this.reset()
      throw error instanceof Error ? error : new Error(String(error))
    })
    return this.ready
  }

  private async handshake(): Promise<void> {
    const clientStatic = await importKeyPair(this.config.keys.privateJwk as Parameters<typeof importKeyPair>[0])
    const clientEph = await generateKeyPair()
    const Ctor = await loadWebSocket()
    const ws = new Ctor(this.config.url, { handshakeTimeout: HANDSHAKE_MS, perMessageDeflate: false, maxPayload: MAX_FRAME_BYTES })
    this.ws = ws
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => fail(new PeerTunnelError(pick('连接电脑超时', 'Timed out connecting to the desktop'), 'tunnel-timeout')), HANDSHAKE_MS)
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
      const done = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      ws.on('open', () => {
        ws.send(JSON.stringify({ t: 'hi', v: PROTOCOL_VERSION, x: TEXT_PROTOCOL, c: this.config.keys.publicKey, e: toB64u(clientEph.raw) }))
      })
      ws.on('error', () => fail(new PeerTunnelError(pick('连不上电脑', 'Could not reach the desktop'), 'tunnel-unreachable')))
      ws.on('close', (code) => {
        if (!settled) return fail(new PeerTunnelError(pick(`与电脑的连接断开了（${code}）`, `The connection to the desktop closed (${code})`), 'tunnel-closed'))
        this.reset()
      })
      ws.on('message', (data: Buffer | string, binary: boolean) => {
        if (binary) return fatal(new PeerTunnelError(pick('电脑发来了二进制帧', 'The desktop sent a binary frame'), 'tunnel-protocol'))
        const text = typeof data === 'string' ? data : data.toString('utf8')
        if (!this.channel) {
          if (text.length > HANDSHAKE_FRAME_MAX) return fail(new PeerTunnelError(pick('电脑的握手消息太大', 'The handshake from the desktop is too large'), 'tunnel-protocol'))
          let hi: { t?: unknown; v?: unknown; e?: unknown }
          try {
            hi = JSON.parse(text) as typeof hi
          } catch {
            return fatal(new PeerTunnelError(pick('电脑的握手消息不对', 'Invalid handshake from the desktop'), 'tunnel-protocol'))
          }
          if (hi.t !== 'hi' || typeof hi.e !== 'string') return fatal(new PeerTunnelError(pick('电脑的握手消息不对', 'Invalid handshake from the desktop'), 'tunnel-protocol'))
          void clientSession({
            clientStatic,
            clientEph,
            serverStaticRaw: fromB64u(this.config.hostKey),
            serverEphRaw: fromB64u(hi.e)
          })
            .then((channel) => {
              this.channel = channel
              return channel.seal({ t: 'auth', name: this.config.deviceName, kind: 'peer', ...(this.config.pairingCode ? { pair: this.config.pairingCode } : {}) })
            })
            .then((frame) => ws.send(frame), (error: unknown) => fatal(error instanceof Error ? error : new Error(String(error))))
          return
        }
        void this.channel.open(text).then((message) => {
          const msg = message as Record<string, unknown>
          if (!settled) {
            if (msg.t === 'denied') return fail(new PeerTunnelError(String(msg.reason ?? pick('电脑拒绝了连接', 'The desktop refused this connection')), 'tunnel-denied'))
            if (msg.t !== 'welcome') return fail(new PeerTunnelError(pick('电脑的回应不对', 'Invalid response from the desktop'), 'tunnel-protocol'))
            done()
            return
          }
          this.frame(msg)
        }, (error: unknown) => fatal(new PeerTunnelError(
          `${pick('电脑发来的加密帧打不开', 'An encrypted frame from the desktop could not be opened')}: ${error instanceof Error ? error.message : String(error)}`,
          'tunnel-protocol'
        )))
      })
    })
  }

  private reset(reason?: Error): void {
    this.dead = true
    this.ws = null
    this.channel = null
    this.ready = null
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      this.finishFile(pending)
      const error = reason ?? new PeerTunnelError(pick('与电脑的连接断开了', 'The connection to the desktop dropped'), 'tunnel-closed')
      pending.onEnd?.(error)
      pending.reject(error)
    }
    this.pending.clear()
  }

  close(): void {
    try {
      this.ws?.close()
    } catch {
    }
    this.reset()
  }

  private finishFile(pending: Pending): void {
    if (!pending.file) return
    try {
      closeSync(pending.file.fd)
    } catch {
    }
    pending.file = null
  }

  private frame(msg: Record<string, unknown>): void {
    const id = typeof msg.id === 'string' ? msg.id : ''
    const pending = this.pending.get(id)
    if (!pending) return
    if (msg.t === 'res') {
      pending.status = Number(msg.status) || 502
      pending.headers = (msg.headers && typeof msg.headers === 'object' ? msg.headers : {}) as Record<string, string>
      pending.open?.(pending.status)
      if (msg.stream) {
        pending.onStart?.(pending.status)
        return
      }
      this.pending.delete(id)
      clearTimeout(pending.timer)
      const bytes = typeof msg.text === 'string' ? Buffer.from(msg.text, 'utf8')
        : typeof msg.body === 'string' ? Buffer.from(msg.body, 'base64') : Buffer.alloc(0)
      if (bytes.length > pending.maxBytes) {
        const error = new PeerTunnelError(this.tooLarge(pending.maxBytes), 'response-too-large')
        pending.onEnd?.(error)
        pending.reject(error)
        this.send({ t: 'abort', id })
        return
      }
      pending.onStart?.(pending.status)
      if (pending.file) {
        pending.bytes = bytes.length
        try {
          if (bytes.length) writeSync(pending.file.fd, bytes)
        } catch {
          this.finishFile(pending)
          pending.reject(new PeerTunnelError(pick('写不进临时文件', 'Could not write the temporary file'), 'download-failed'))
          return
        }
        this.finishFile(pending)
      }
      pending.resolve({ status: pending.status, headers: pending.headers, text: bytes.toString('utf8'), bytes: pending.file ? pending.bytes : bytes.length, body: bytes })
      return
    }
    if (msg.t === 'chunk') {
      const bytes = typeof msg.text === 'string' ? Buffer.from(msg.text, 'utf8')
        : typeof msg.data === 'string' ? Buffer.from(msg.data, 'base64') : Buffer.alloc(0)
      if (!bytes.length || pending.stream) return
      pending.bytes += bytes.length
      if (pending.bytes > pending.maxBytes) {
        this.pending.delete(id)
        clearTimeout(pending.timer)
        this.finishFile(pending)
        pending.reject(new PeerTunnelError(this.tooLarge(pending.maxBytes), 'response-too-large'))
        this.send({ t: 'abort', id })
        return
      }
      if (!pending.file) {
        pending.chunks.push(bytes)
        return
      }
      try {
        writeSync(pending.file.fd, bytes)
      } catch {
        this.pending.delete(id)
        clearTimeout(pending.timer)
        this.finishFile(pending)
        pending.reject(new PeerTunnelError(pick('写不进临时文件', 'Could not write the temporary file'), 'download-failed'))
        this.send({ t: 'abort', id })
      }
      return
    }
    if (msg.t === 'end') {
      this.pending.delete(id)
      clearTimeout(pending.timer)
      this.finishFile(pending)
      if (typeof msg.error === 'string' && msg.error) {
        const error = new PeerTunnelError(msg.error, 'response-failed')
        pending.onEnd?.(error)
        pending.reject(error)
        return
      }
      pending.onEnd?.()
      const body = Buffer.concat(pending.chunks)
      pending.resolve({ status: pending.status, headers: pending.headers, text: body.toString('utf8'), bytes: pending.bytes, body })
    }
  }

  private tooLarge(maxBytes: number): string {
    return pick(`电脑返回的内容超过 ${Math.round(maxBytes / 1024 / 1024)}MB，已停止读取`, `The desktop returned more than ${Math.round(maxBytes / 1024 / 1024)}MB and the read was stopped`)
  }

  private send(frame: Record<string, unknown>): void {
    const channel = this.channel
    if (!channel) return
    void channel.seal(frame).then((text) => {
      if (this.ws?.readyState === WS_OPEN) this.ws.send(text)
    }, () => undefined)
  }

  private pendingFor(seq: string, limitMs: number, maxBytes: number): { id: string; pending: Pending; promise: Promise<TunnelReply> } {
    const id = `${seq}${++this.seq}`
    let entry!: Pending
    const promise = new Promise<TunnelReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.send({ t: 'abort', id })
        reject(new PeerTunnelError(pick('电脑没有及时回应', 'The desktop did not answer in time'), 'tunnel-timeout'))
      }, limitMs)
      timer.unref?.()
      entry = { resolve, reject, timer, chunks: [], bytes: 0, maxBytes, status: 0, headers: {}, stream: false, file: null }
    })
    return { id, pending: entry, promise }
  }

  async request(method: 'GET' | 'POST', path: string, options: { headers?: Record<string, string>; body?: unknown; timeoutMs?: number; maxBytes?: number } = {}): Promise<TunnelReply> {
    await this.connect()
    const { id, pending, promise } = this.pendingFor('p', options.timeoutMs ?? 30_000, options.maxBytes ?? JSON_MAX_BYTES)
    this.pending.set(id, pending)
    this.send({
      t: 'req',
      id,
      method,
      path,
      headers: options.headers ?? {},
      ...(options.body === undefined ? {} : { text: JSON.stringify(options.body) })
    })
    return promise
  }

  async download(path: string, body: unknown, file: string, maxBytes: number, timeoutMs = 30 * 60_000, headers: Record<string, string> = {}): Promise<TunnelReply> {
    await this.connect()
    const { id, pending, promise } = this.pendingFor('d', timeoutMs, maxBytes)
    pending.onStart = (status) => {
      const type = pending.headers['content-type'] ?? ''
      if (type.includes('application/json') || status < 200 || status >= 300) return
      try {
        pending.file = { fd: openSync(file, 'w') }
      } catch {
        this.pending.delete(id)
        clearTimeout(pending.timer)
        pending.reject(new PeerTunnelError(pick('建不了临时文件', 'Could not create the temporary file'), 'download-failed'))
        this.send({ t: 'abort', id })
      }
    }
    this.pending.set(id, pending)
    this.send({ t: 'req', id, method: 'POST', path, headers: { ...headers, 'content-type': 'application/json' }, text: JSON.stringify(body) })
    return promise
  }

  async upload(path: string, file: string, headers: Record<string, string>): Promise<TunnelReply> {
    await this.connect()
    const { id, pending, promise } = this.pendingFor('u', 30 * 60_000, JSON_MAX_BYTES)
    const handle = await open(file, 'r')
    try {
      const size = (await handle.stat()).size
      this.pending.set(id, pending)
      this.send({ t: 'req', id, method: 'POST', path, headers: { ...headers, 'content-length': String(size) }, stream: 'in' })
      let offset = 0
      while (offset < size) {
        const length = Math.min(UPLOAD_CHUNK, size - offset)
        const buffer = Buffer.alloc(length)
        const read = await handle.read(buffer, 0, length, offset)
        if (read.bytesRead <= 0) break
        await this.sealNow({ t: 'up', id, data: buffer.subarray(0, read.bytesRead).toString('base64') })
        offset += read.bytesRead
      }
      await this.sealNow({ t: 'up-end', id })
    } catch (error) {
      this.pending.delete(id)
      clearTimeout(pending.timer)
      throw error instanceof Error ? error : new Error(String(error))
    } finally {
      await handle.close().catch(() => undefined)
    }
    return promise
  }

  private sealNow(frame: Record<string, unknown>): Promise<void> {
    const channel = this.channel
    if (!channel) return Promise.reject(new PeerTunnelError(pick('与电脑的连接断开了', 'The connection to the desktop dropped'), 'tunnel-closed'))
    return channel.seal(frame).then((text) => {
      if (this.ws?.readyState !== WS_OPEN) throw new PeerTunnelError(pick('与电脑的连接断开了', 'The connection to the desktop dropped'), 'tunnel-closed')
      this.ws.send(text)
    })
  }

  async openStream(path: string, headers: Record<string, string>, onEnd: (error?: Error) => void): Promise<{ ok: true; stop: () => void } | { ok: false; status: number; text: string }> {
    await this.connect()
    const id = `s${++this.seq}`
    const timer = setTimeout(() => undefined, 0)
    timer.unref?.()
    let stopped = false
    let settle: (value: { ok: true; stop: () => void } | { ok: false; status: number; text: string }) => void
    const opened = new Promise<{ ok: true; stop: () => void } | { ok: false; status: number; text: string }>((resolve) => {
      settle = resolve
    })
    const end = (error?: Error): void => {
      if (stopped) return
      stopped = true
      clearTimeout(timer)
      onEnd(error)
    }
    const stop = (): void => {
      stopped = true
      clearTimeout(timer)
      if (!this.pending.has(id)) return
      this.pending.delete(id)
      this.send({ t: 'abort', id })
    }
    const pending: Pending = {
      resolve: (reply) => settle({ ok: false, status: reply.status, text: reply.text }),
      reject: (error) => settle({ ok: false, status: 0, text: error.message }),
      timer,
      chunks: [],
      bytes: 0,
      maxBytes: JSON_MAX_BYTES,
      status: 0,
      headers: {},
      stream: true,
      file: null,
      open: (status) => {
        if (status >= 200 && status < 300) settle({ ok: true, stop })
      },
      onEnd: end
    }
    this.pending.set(id, pending)
    this.send({ t: 'req', id, method: 'GET', path, headers })
    return opened
  }
}
