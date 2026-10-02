/**
 * 经中继连接电脑：不用 Tailscale、不开端口。电脑上的砚主动连中继，手机加入同一个房间，
 * 两端用与礁石相同的协议握手（P-256 三重 ECDH + HKDF-SHA256 → AES-256-GCM 计数帧），中继只看到密文。
 * 握手后在加密通道里收发「HTTP 请求帧」，由电脑转给本机远程接口；事件流分块传回。
 *
 * React Native 没有 WebCrypto，这里用纯 JS 的 @noble 库（随机数由 react-native-get-random-values 提供）。
 * 协议与帧格式见礁石仓库 docs/specs/hub-relay.md 与桌面 src/main/relay-bridge/。
 */
import { p256 } from '@noble/curves/nist.js'
import { gcm } from '@noble/ciphers/aes.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'

const PROTOCOL_VERSION = 1
const LABEL = utf8ToBytes('reef-v1')
const INFO = utf8ToBytes('reef-v1 keys')
const HANDSHAKE_MS = 15_000

/* ---------------------------------------------------------------- 编码 */

/** UTF-8 编码（不依赖 TextEncoder）。 */
export function utf8ToBytes(text: string): Uint8Array {
  const out: number[] = []
  for (const ch of text) {
    let c = ch.codePointAt(0) ?? 0
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else {
      c = Math.min(c, 0x10ffff)
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    }
  }
  return new Uint8Array(out)
}

/**
 * UTF-8 解码（不依赖 TextDecoder）。返回解出的文字与末尾不完整的字节数（流式续接用）；非法字节替换为 U+FFFD。
 */
export function decodeUtf8(bytes: Uint8Array): { text: string; rest: number } {
  let text = ''
  let i = 0
  while (i < bytes.length) {
    const b = bytes[i]
    const need = b < 0x80 ? 0 : b >= 0xf0 && b < 0xf8 ? 3 : b >= 0xe0 ? 2 : b >= 0xc0 ? 1 : -1
    if (need < 0) {
      text += '\ufffd'
      i++
      continue
    }
    let c = need === 0 ? b : need === 1 ? b & 31 : need === 2 ? b & 15 : b & 7
    let ok = true
    for (let k = 1; k <= need; k++) {
      const n = bytes[i + k]
      if (n === undefined) return { text, rest: bytes.length - i }
      if ((n & 0xc0) !== 0x80) { ok = false; break }
      c = (c << 6) | (n & 63)
    }
    if (!ok) {
      text += '\ufffd'
      i++
      continue
    }
    text += String.fromCodePoint(c)
    i += need + 1
  }
  return { text, rest: 0 }
}

export function bytesToUtf8(bytes: Uint8Array): string {
  const { text, rest } = decodeUtf8(bytes)
  return rest ? `${text}\ufffd` : text
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_INDEX = new Map([...B64].map((c, i) => [c, i] as const))

/** 标准 base64（不依赖 atob / btoa）；隧道帧里的 body / chunk 用它。 */
export function toB64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63]
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : '='
    out += i + 2 < bytes.length ? B64[n & 63] : '='
  }
  return out
}

export function fromB64(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let o = 0
  for (let i = 0; i < clean.length; i += 4) {
    const v = [0, 1, 2, 3].map((k) => (i + k < clean.length ? B64_INDEX.get(clean[i + k]) : 0))
    if (v.some((x) => x === undefined)) throw new Error('不是 base64')
    const n = ((v[0] as number) << 18) | ((v[1] as number) << 12) | ((v[2] as number) << 6) | (v[3] as number)
    if (o < out.length) out[o++] = (n >> 16) & 255
    if (o < out.length) out[o++] = (n >> 8) & 255
    if (o < out.length) out[o++] = n & 255
  }
  return out
}

export function toB64u(bytes: Uint8Array): string {
  return toB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromB64u(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('不是 base64url')
  return fromB64(text.replace(/-/g, '+').replace(/_/g, '/'))
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

/* ---------------------------------------------------------------- 配对链接 */

export interface RelayPairing {
  /** 中继加入地址 wss://…/v1/join/<room> */
  join: string
  /** 电脑主机公钥（base64url，65 字节未压缩） */
  hostKey: string
  computerName: string
  /** 一次性中继配对码 */
  relayCode: string
  /** 砚 6 位配对码 */
  code: string
}

/** 解析电脑生成的中继配对链接：inkstone://relay#p=… 或 yan://relay#p=…（也接受只粘贴 #p=… 片段）。 */
export function parseRelayLink(input: string): RelayPairing | null {
  const match = /^(?:(?:inkstone|yan):\/\/relay)?#p=([A-Za-z0-9_-]+)$/i.exec(input.trim())
  if (!match) return null
  try {
    const p = JSON.parse(bytesToUtf8(fromB64u(match[1]))) as Record<string, unknown>
    if (p.v !== 1 || p.k !== 'yan' || p.m !== 'phone') return null
    if (typeof p.s !== 'string' || typeof p.c !== 'string' || typeof p.r !== 'string' || typeof p.y !== 'string') return null
    if (!/^wss?:\/\/[^\s]+\/v1\/join\/[A-Za-z0-9_-]{10,64}$/.test(p.r) || !/^\d{6}$/.test(p.y)) return null
    if (fromB64u(p.s).length !== 65) return null
    return { join: p.r, hostKey: p.s, computerName: typeof p.n === 'string' ? p.n.slice(0, 60) : '电脑', relayCode: p.c, code: p.y }
  } catch {
    return null
  }
}

/** 保存在钥匙串里的中继连接信息（客户端私钥只存这里）。 */
export interface RelayConfig {
  join: string
  hostKey: string
  /** 手机的长期私钥（base64url，32 字节） */
  clientKey: string
}

export function newClientKey(): string {
  return toB64u(p256.utils.randomSecretKey())
}

/* ---------------------------------------------------------------- 加密通道 */

function ecdh(secret: Uint8Array, publicRaw: Uint8Array): Uint8Array {
  // noble 返回压缩点（33 字节）；WebCrypto 的 ECDH deriveBits 是 x 坐标，取后 32 字节保持一致。
  return p256.getSharedSecret(secret, publicRaw, true).slice(1)
}

class Channel {
  private sendCount = 0
  private recvCount = 0
  constructor(private readonly sendKey: Uint8Array, private readonly recvKey: Uint8Array) {}

  seal(obj: unknown): string {
    const ctr = new Uint8Array(8)
    new DataView(ctr.buffer).setBigUint64(0, BigInt(this.sendCount++))
    const ct = gcm(this.sendKey, concat(new Uint8Array(4), ctr)).encrypt(utf8ToBytes(JSON.stringify(obj)))
    return `x.${toB64u(concat(ctr, ct))}`
  }

  open(frame: string): Record<string, unknown> {
    if (!frame.startsWith('x.')) throw new Error('不是加密帧')
    const bytes = fromB64u(frame.slice(2))
    if (bytes.length < 24) throw new Error('加密帧太短')
    const ctr = bytes.slice(0, 8)
    const n = Number(new DataView(ctr.buffer).getBigUint64(0))
    if (n !== this.recvCount) throw new Error('加密帧计数不对')
    const plain = gcm(this.recvKey, concat(new Uint8Array(4), ctr)).decrypt(bytes.slice(8))
    this.recvCount++
    return JSON.parse(bytesToUtf8(plain)) as Record<string, unknown>
  }
}

function clientChannel(clientSecret: Uint8Array, ephSecret: Uint8Array, hostRaw: Uint8Array, hostEphRaw: Uint8Array): Channel {
  const clientRaw = p256.getPublicKey(clientSecret, false)
  const ephRaw = p256.getPublicKey(ephSecret, false)
  const ikm = concat(ecdh(ephSecret, hostEphRaw), ecdh(ephSecret, hostRaw), ecdh(clientSecret, hostEphRaw))
  const salt = sha256(concat(LABEL, hostRaw, clientRaw, ephRaw, hostEphRaw))
  const okm = hkdf(sha256, ikm, salt, INFO, 64)
  return new Channel(okm.slice(0, 32), okm.slice(32, 64))
}

/* ---------------------------------------------------------------- 隧道 */

export interface TunnelResponse {
  status: number
  headers: Record<string, string>
  body: Uint8Array
}

type Pending = {
  resolve(res: TunnelResponse): void
  reject(error: Error): void
  status?: number
  headers?: Record<string, string>
  chunks: Uint8Array[]
  onStart?(status: number): void
  onChunk?(bytes: Uint8Array): void
  stream: boolean
}

export class RelayError extends Error {
  constructor(message: string, readonly denied = false) {
    super(message)
    this.name = 'RelayError'
  }
}

/** 一条到电脑的加密隧道。断线后下一次请求自动重连（已登记的手机不需要配对码）。 */
export class RelayTunnel {
  private static readonly shared = new Map<string, RelayTunnel>()
  private ws: WebSocket | null = null
  private channel: Channel | null = null
  private ready: Promise<void> | null = null
  private readonly pending = new Map<string, Pending>()
  private seq = 0

  static for(config: RelayConfig, deviceName?: string): RelayTunnel {
    const key = `${config.join}|${config.clientKey}`
    let tunnel = RelayTunnel.shared.get(key)
    if (!tunnel) {
      tunnel = new RelayTunnel(config, deviceName)
      RelayTunnel.shared.set(key, tunnel)
    }
    return tunnel
  }

  constructor(private readonly config: RelayConfig, private readonly deviceName = '砚手机端') {}

  /** 建立连接；首次配对时带上中继配对码。 */
  connect(pairCode?: string): Promise<void> {
    if (this.ready) return this.ready
    this.ready = new Promise<void>((resolve, reject) => {
      const clientSecret = fromB64u(this.config.clientKey)
      const ephSecret = p256.utils.randomSecretKey()
      const ws = new WebSocket(this.config.join)
      this.ws = ws
      let state: 'hello' | 'auth' | 'open' = 'hello'
      const timer = setTimeout(() => fail(new RelayError('连接电脑超时：请确认电脑上的砚在运行，并开启了中继接入')), HANDSHAKE_MS)
      const fail = (error: Error) => {
        clearTimeout(timer)
        if (state !== 'open') reject(error)
        this.teardown(error)
      }
      ws.onopen = () => {
        ws.send(JSON.stringify({ t: 'hi', v: PROTOCOL_VERSION, c: toB64u(p256.getPublicKey(clientSecret, false)), e: toB64u(p256.getPublicKey(ephSecret, false)) }))
      }
      ws.onmessage = (event) => {
        const text = String(event.data)
        try {
          if (state === 'hello') {
            const hi = JSON.parse(text) as { t?: unknown; e?: unknown }
            if (hi.t !== 'hi' || typeof hi.e !== 'string') throw new RelayError('电脑的握手消息不对')
            this.channel = clientChannel(clientSecret, ephSecret, fromB64u(this.config.hostKey), fromB64u(hi.e))
            state = 'auth'
            ws.send(this.channel.seal({ t: 'auth', name: this.deviceName, ...(pairCode ? { pair: pairCode } : {}) }))
            return
          }
          const msg = this.channel!.open(text)
          if (state === 'auth') {
            if (msg.t === 'denied') throw new RelayError(String(msg.reason ?? '电脑拒绝了连接'), true)
            if (msg.t !== 'welcome') throw new RelayError('电脑的回应不对')
            state = 'open'
            clearTimeout(timer)
            resolve()
            return
          }
          this.frame(msg)
        } catch (error) {
          fail(error instanceof Error ? error : new RelayError(String(error)))
        }
      }
      ws.onerror = () => fail(new RelayError('连不上中继：请检查手机网络'))
      ws.onclose = (event) => fail(new RelayError(event.code === 4004 ? '电脑不在线：请确认电脑开机、砚在运行并开启了中继接入' : '与电脑的连接断开了'))
    })
    return this.ready
  }

  private teardown(error: Error): void {
    const ws = this.ws
    this.ws = null
    this.channel = null
    this.ready = null
    try {
      ws?.close()
    } catch {
      /* 已关闭 */
    }
    for (const p of this.pending.values()) p.reject(error)
    this.pending.clear()
  }

  close(): void {
    this.teardown(new RelayError('连接已关闭'))
  }

  private frame(msg: Record<string, unknown>): void {
    const id = typeof msg.id === 'string' ? msg.id : ''
    const p = this.pending.get(id)
    if (!p) return
    if (msg.t === 'res') {
      p.status = Number(msg.status)
      p.headers = (msg.headers ?? {}) as Record<string, string>
      if (msg.stream) {
        p.stream = true
        p.onStart?.(p.status)
        return
      }
      this.pending.delete(id)
      p.resolve({ status: p.status, headers: p.headers, body: typeof msg.body === 'string' ? fromB64(msg.body) : new Uint8Array(0) })
    } else if (msg.t === 'chunk' && typeof msg.data === 'string') {
      const bytes = fromB64(msg.data)
      if (p.onChunk) p.onChunk(bytes)
      else p.chunks.push(bytes)
    } else if (msg.t === 'end') {
      this.pending.delete(id)
      p.resolve({ status: p.status ?? 502, headers: p.headers ?? {}, body: concat(...p.chunks) })
    }
  }

  private async send(frame: Record<string, unknown>): Promise<void> {
    await this.connect()
    if (!this.ws || !this.channel) throw new RelayError('与电脑的连接断开了')
    this.ws.send(this.channel.seal(frame))
  }

  /** 发一个请求；body 为已序列化的字符串。 */
  async request(method: 'GET' | 'POST', path: string, init: { headers?: Record<string, string>; body?: string; timeoutMs?: number } = {}): Promise<TunnelResponse> {
    const id = `m${++this.seq}`
    const result = new Promise<TunnelResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        void this.send({ t: 'abort', id }).catch(() => undefined)
        reject(new RelayError('连接超时：请确认电脑上的砚在运行'))
      }, init.timeoutMs ?? 20_000)
      this.pending.set(id, {
        resolve: (r) => { clearTimeout(timer); resolve(r) },
        reject: (e) => { clearTimeout(timer); reject(e) },
        chunks: [],
        stream: false
      })
    })
    try {
      await this.send({ t: 'req', id, method, path, headers: init.headers ?? {}, ...(init.body !== undefined ? { body: toB64(utf8ToBytes(init.body)) } : {}) })
    } catch (error) {
      this.pending.get(id)?.reject(error instanceof Error ? error : new RelayError(String(error)))
      this.pending.delete(id)
    }
    return result
  }

  /** 打开一条事件流（SSE）；返回取消函数。onEnd 在流结束或断线时调用。 */
  stream(path: string, headers: Record<string, string>, handlers: { onStart(status: number): void; onChunk(text: string): void; onEnd(error?: Error): void }): () => void {
    const id = `s${++this.seq}`
    let done = false
    const end = (error?: Error) => {
      if (done) return
      done = true
      handlers.onEnd(error)
    }
    let carry = new Uint8Array(0)
    this.pending.set(id, {
      resolve: () => end(),
      reject: (e) => end(e),
      chunks: [],
      stream: true,
      onStart: handlers.onStart,
      onChunk: (bytes) => {
        const all = carry.length ? concat(carry, bytes) : bytes
        const { text, rest } = decodeUtf8(all)
        carry = rest ? all.slice(all.length - rest) : new Uint8Array(0)
        if (text) handlers.onChunk(text)
      }
    })
    void this.send({ t: 'req', id, method: 'GET', path, headers }).catch((error: unknown) => {
      this.pending.delete(id)
      end(error instanceof Error ? error : new RelayError(String(error)))
    })
    return () => {
      if (!this.pending.has(id)) return
      this.pending.delete(id)
      void this.send({ t: 'abort', id }).catch(() => undefined)
      end()
    }
  }
}
