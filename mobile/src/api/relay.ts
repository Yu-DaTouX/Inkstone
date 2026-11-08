import { pick } from '../../../src/shared/ui-lang'
import { p256 } from '@noble/curves/nist.js'
import { gcm } from '@noble/ciphers/aes.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'

const PROTOCOL_VERSION = 1
const TEXT_PROTOCOL = 2
const LABEL = utf8ToBytes('reef-v1')
const INFO = utf8ToBytes('reef-v1 keys')
const HANDSHAKE_MS = 15_000
const DIRECT_MS = 2_500

export function utf8ToBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length * 3)
  let o = 0
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i)
    if (c < 0x80) {
      out[o++] = c
      continue
    }
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00)
        i++
        out[o++] = 0xf0 | (c >> 18)
        out[o++] = 0x80 | ((c >> 12) & 63)
        out[o++] = 0x80 | ((c >> 6) & 63)
        out[o++] = 0x80 | (c & 63)
        continue
      }
    }
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd
    if (c < 0x800) {
      out[o++] = 0xc0 | (c >> 6)
      out[o++] = 0x80 | (c & 63)
    } else {
      out[o++] = 0xe0 | (c >> 12)
      out[o++] = 0x80 | ((c >> 6) & 63)
      out[o++] = 0x80 | (c & 63)
    }
  }
  return out.subarray(0, o)
}

const UNIT_BATCH = 4096

export function decodeUtf8(bytes: Uint8Array): { text: string; rest: number } {
  const parts: string[] = []
  const units = new Uint16Array(Math.min(UNIT_BATCH + 2, bytes.length + 2))
  let u = 0
  const flush = () => {
    parts.push(String.fromCharCode.apply(null, units.subarray(0, u) as unknown as number[]))
    u = 0
  }
  let i = 0
  const len = bytes.length
  while (i < len) {
    if (u >= UNIT_BATCH) flush()
    const b = bytes[i]
    if (b < 0x80) {
      units[u++] = b
      i++
      continue
    }
    const need = b >= 0xf0 && b <= 0xf4 ? 3 : b >= 0xe0 && b <= 0xef ? 2 : b >= 0xc2 && b <= 0xdf ? 1 : -1
    if (need < 0) {
      units[u++] = 0xfffd
      i++
      continue
    }
    const lo = b === 0xe0 ? 0xa0 : b === 0xf0 ? 0x90 : 0x80
    const hi = b === 0xed ? 0x9f : b === 0xf4 ? 0x8f : 0xbf
    let c = need === 1 ? b & 31 : need === 2 ? b & 15 : b & 7
    let k = 1
    for (; k <= need && i + k < len; k++) {
      const n = bytes[i + k]
      if (k === 1 ? n < lo || n > hi : (n & 0xc0) !== 0x80) break
      c = (c << 6) | (n & 63)
    }
    if (k <= need) {
      if (i + k >= len) {
        if (u) flush()
        return { text: parts.join(''), rest: len - i }
      }
      units[u++] = 0xfffd
      i += k
      continue
    }
    if (c >= 0x10000) {
      c -= 0x10000
      units[u++] = 0xd800 + (c >> 10)
      units[u++] = 0xdc00 + (c & 0x3ff)
    } else units[u++] = c
    i += need + 1
  }
  if (u) flush()
  return { text: parts.join(''), rest: 0 }
}

export function bytesToUtf8(bytes: Uint8Array): string {
  const { text, rest } = decodeUtf8(bytes)
  return rest ? `${text}\ufffd` : text
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64U = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const B64_STD = new Int16Array(128).fill(-1)
const B64_URL = new Int16Array(128).fill(-1)
for (let i = 0; i < 64; i++) {
  B64_STD[B64.charCodeAt(i)] = i
  B64_URL[B64U.charCodeAt(i)] = i
}
const B64_CODES = Uint8Array.from(B64, (c) => c.charCodeAt(0))
const B64U_CODES = Uint8Array.from(B64U, (c) => c.charCodeAt(0))

function encodeB64(bytes: Uint8Array, codes: Uint8Array, pad: boolean): string {
  const parts: string[] = []
  const units = new Uint16Array(Math.min(UNIT_BATCH, Math.ceil(bytes.length / 3) * 4))
  let u = 0
  const flush = () => {
    parts.push(String.fromCharCode.apply(null, units.subarray(0, u) as unknown as number[]))
    u = 0
  }
  const len = bytes.length
  const whole = len - (len % 3)
  for (let i = 0; i < whole; i += 3) {
    if (u + 4 > units.length) flush()
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    units[u++] = codes[(n >> 18) & 63]
    units[u++] = codes[(n >> 12) & 63]
    units[u++] = codes[(n >> 6) & 63]
    units[u++] = codes[n & 63]
  }
  if (u) flush()
  if (whole < len) {
    const n = (bytes[whole] << 16) | ((whole + 1 < len ? bytes[whole + 1] : 0) << 8)
    let tail = String.fromCharCode(codes[(n >> 18) & 63], codes[(n >> 12) & 63])
    if (whole + 1 < len) tail += String.fromCharCode(codes[(n >> 6) & 63])
    else if (pad) tail += '='
    if (pad) tail += '='
    parts.push(tail)
  }
  return parts.join('')
}

function decodeB64(text: string, table: Int16Array, error: string): Uint8Array {
  let end = text.length
  while (end > 0 && text.charCodeAt(end - 1) === 61) end--
  if (end % 4 === 1) throw new Error(error)
  const out = new Uint8Array(Math.floor((end * 3) / 4))
  let o = 0
  let i = 0
  const whole = end - (end % 4)
  for (; i < whole; i += 4) {
    const a = text.charCodeAt(i), b = text.charCodeAt(i + 1), c = text.charCodeAt(i + 2), d = text.charCodeAt(i + 3)
    const va = a < 128 ? table[a] : -1, vb = b < 128 ? table[b] : -1, vc = c < 128 ? table[c] : -1, vd = d < 128 ? table[d] : -1
    if ((va | vb | vc | vd) < 0) throw new Error(error)
    const n = (va << 18) | (vb << 12) | (vc << 6) | vd
    out[o++] = (n >> 16) & 255
    out[o++] = (n >> 8) & 255
    out[o++] = n & 255
  }
  if (i < end) {
    let n = 0
    for (let k = 0; k < 4; k++) {
      const code = i + k < end ? text.charCodeAt(i + k) : 65
      const v = code < 128 ? table[code] : -1
      if (v < 0) throw new Error(error)
      n = (n << 6) | (i + k < end ? v : 0)
    }
    if (o < out.length) out[o++] = (n >> 16) & 255
    if (o < out.length) out[o++] = (n >> 8) & 255
  }
  return out
}

export function toB64(bytes: Uint8Array): string {
  return encodeB64(bytes, B64_CODES, true)
}

export function fromB64(text: string): Uint8Array {
  return decodeB64(text, B64_STD, pick('不是 base64', 'Not base64'))
}

export function toB64u(bytes: Uint8Array): string {
  return encodeB64(bytes, B64U_CODES, false)
}

export function fromB64u(text: string): Uint8Array {
  if (text.indexOf('=') >= 0) throw new Error(pick('不是 base64url', 'Not base64url'))
  return decodeB64(text, B64_URL, pick('不是 base64url', 'Not base64url'))
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

export interface RelayPairing {
  join?: string
  direct?: string[]
  hostKey: string
  computerName: string
  relayCode: string
  code: string
}

export function parseRelayLink(input: string): RelayPairing | null {
  const match = /^(?:(?:inkstone|yan):\/\/relay)?#p=([A-Za-z0-9_-]+)$/i.exec(input.trim())
  if (!match) return null
  try {
    const p = JSON.parse(bytesToUtf8(fromB64u(match[1]))) as Record<string, unknown>
    if (p.v !== 1 || p.k !== 'yan' || p.m !== 'phone') return null
    if (typeof p.s !== 'string' || typeof p.c !== 'string' || typeof p.y !== 'string' || !/^\d{6}$/.test(p.y)) return null
    const join = typeof p.r === 'string' && /^wss?:\/\/[^\s]+\/v1\/join\/[A-Za-z0-9_-]{10,64}$/.test(p.r) ? p.r : undefined
    if (p.r !== undefined && !join) return null
    const direct = Array.isArray(p.d) ? p.d.filter((url): url is string => typeof url === 'string' && DIRECT_URL.test(url)).slice(0, 4) : []
    if (!join && !direct.length) return null
    if (fromB64u(p.s).length !== 65) return null
    return { ...(join ? { join } : {}), ...(direct.length ? { direct } : {}), hostKey: p.s, computerName: typeof p.n === 'string' ? p.n.slice(0, 60) : pick('电脑', 'Desktop'), relayCode: p.c, code: p.y }
  } catch {
    return null
  }
}

export interface RelayConfig {
  join?: string
  direct?: string[]
  hostKey: string
  clientKey: string
}

export const DIRECT_URL = /^wss?:\/\/[^\s/]+\/remote\/v1\/tunnel$/

export function directTunnelUrl(baseUrl: string, path = '/remote/v1/tunnel'): string | null {
  const match = /^(http|https):\/\/([^\s/]+)\/?$/i.exec(baseUrl.trim())
  if (!match || path !== '/remote/v1/tunnel') return null
  return `${match[1].toLowerCase() === 'https' ? 'wss' : 'ws'}://${match[2]}${path}`
}

export function newClientKey(): string {
  return toB64u(p256.utils.randomSecretKey())
}

export function relayClientPublicKey(clientKey: string): string {
  return toB64u(p256.getPublicKey(fromB64u(clientKey), false))
}

function ecdh(secret: Uint8Array, publicRaw: Uint8Array): Uint8Array {
  return p256.getSharedSecret(secret, publicRaw, true).slice(1)
}

export interface FrameCipher {
  open(key: string, frame: string, expected: number): string
  seal(key: string, counter: number, text: string): string
}

let frameCipher: FrameCipher | null = null

export function setFrameCipher(cipher: FrameCipher | null): boolean {
  frameCipher = null
  if (!cipher) return false
  try {
    const key = new Uint8Array(32).map((_, i) => i * 7 + 1)
    const id = toB64u(key)
    const sample = { t: 'probe', text: 'é ✓ 😀 ok' }
    const js = new Channel(key, key)
    const viaJs = js.seal(sample)
    if (cipher.open(id, viaJs, 0) !== JSON.stringify(sample)) return false
    const native = cipher.seal(id, 0, JSON.stringify(sample))
    if (JSON.stringify(new Channel(key, key).open(native)) !== JSON.stringify(sample)) return false
  } catch {
    return false
  }
  frameCipher = cipher
  return true
}

class Channel {
  private sendCount = 0
  private recvCount = 0
  private readonly sendId: string
  private readonly recvId: string
  constructor(private readonly sendKey: Uint8Array, private readonly recvKey: Uint8Array) {
    this.sendId = toB64u(sendKey)
    this.recvId = toB64u(recvKey)
  }

  seal(obj: unknown): string {
    const text = JSON.stringify(obj)
    if (frameCipher) return frameCipher.seal(this.sendId, this.sendCount++, text)
    const ctr = new Uint8Array(8)
    new DataView(ctr.buffer).setBigUint64(0, BigInt(this.sendCount++))
    const ct = gcm(this.sendKey, concat(new Uint8Array(4), ctr)).encrypt(utf8ToBytes(text))
    return `x.${toB64u(concat(ctr, ct))}`
  }

  open(frame: string): Record<string, unknown> {
    if (!frame.startsWith('x.')) throw new Error(pick('不是加密帧', 'Not an encrypted frame'))
    if (frameCipher) {
      const text = frameCipher.open(this.recvId, frame, this.recvCount)
      this.recvCount++
      return JSON.parse(text) as Record<string, unknown>
    }
    const bytes = fromB64u(frame.slice(2))
    if (bytes.length < 24) throw new Error(pick('加密帧太短', 'Encrypted frame too short'))
    const ctr = bytes.slice(0, 8)
    const n = Number(new DataView(ctr.buffer).getBigUint64(0))
    if (n !== this.recvCount) throw new Error(pick('加密帧计数不对', 'Encrypted frame count mismatch'))
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

type Payload = { bytes?: Uint8Array; text?: string; base64?: string }

export class TunnelResponse {
  private payload: Payload
  constructor(readonly status: number, readonly headers: Record<string, string>, payload: Payload) {
    this.payload = payload
  }

  get body(): Uint8Array {
    const p = this.payload
    if (!p.bytes) p.bytes = p.text !== undefined ? utf8ToBytes(p.text) : p.base64 !== undefined ? fromB64(p.base64) : new Uint8Array(0)
    return p.bytes
  }

  get text(): string {
    const p = this.payload
    if (p.text === undefined) p.text = bytesToUtf8(this.body)
    return p.text
  }

  get base64(): string {
    const p = this.payload
    if (p.base64 === undefined) p.base64 = toB64(this.body)
    return p.base64
  }

  get byteLength(): number {
    const p = this.payload
    if (p.bytes) return p.bytes.length
    if (p.base64 !== undefined) return Math.floor((p.base64.replace(/=+$/, '').length * 3) / 4)
    return this.body.length
  }
}

type Pending = {
  resolve(res: TunnelResponse): void
  reject(error: Error): void
  status?: number
  headers?: Record<string, string>
  chunks: Uint8Array[]
  texts: string[]
  onStart?(status: number): void
  onChunk?(bytes: Uint8Array): void
  onText?(text: string): void
  stream: boolean
}

export class RelayError extends Error {
  constructor(message: string, readonly denied = false) {
    super(message)
    this.name = 'RelayError'
  }
}

export class RelayTunnel {
  private static readonly shared = new Map<string, RelayTunnel>()
  private ws: WebSocket | null = null
  private channel: Channel | null = null
  private ready: Promise<void> | null = null
  private readonly pending = new Map<string, Pending>()
  private seq = 0
  private version = PROTOCOL_VERSION
  private generation = 0
  private via: 'direct' | 'relay' = 'relay'

  static for(config: RelayConfig, deviceName?: string): RelayTunnel {
    const key = `${config.hostKey}|${config.clientKey}`
    let tunnel = RelayTunnel.shared.get(key)
    if (!tunnel) {
      tunnel = new RelayTunnel(config, deviceName)
      RelayTunnel.shared.set(key, tunnel)
    }
    return tunnel
  }

  constructor(private readonly config: RelayConfig, private readonly deviceName = pick('砚手机端', 'Inkstone mobile')) {}

  get route(): 'direct' | 'relay' | null {
    return this.ws ? this.via : null
  }

  private openDirect(): Promise<WebSocket | null> {
    const urls = this.config.direct ?? []
    if (!urls.length) return Promise.resolve(null)
    return new Promise((resolve) => {
      let left = urls.length
      let done = false
      const sockets: WebSocket[] = []
      const finish = (winner: WebSocket | null) => {
        if (done) return
        done = true
        clearTimeout(timer)
        for (const s of sockets) {
          s.onopen = null
          s.onerror = null
          s.onclose = null
          if (s !== winner) try { s.close() } catch { }
        }
        resolve(winner)
      }
      const lost = () => {
        left -= 1
        if (left <= 0) finish(null)
      }
      const timer = setTimeout(() => finish(null), DIRECT_MS)
      for (const url of urls) {
        let s: WebSocket
        try {
          s = new WebSocket(url)
        } catch {
          lost()
          continue
        }
        sockets.push(s)
        let gone = false
        const drop = () => {
          if (gone) return
          gone = true
          lost()
        }
        s.onopen = () => finish(s)
        s.onerror = drop
        s.onclose = drop
      }
    })
  }

  connect(pairCode?: string): Promise<void> {
    if (this.ready) return this.ready
    const generation = ++this.generation
    const attempt = this.openDirect().then((direct) => new Promise<void>((resolve, reject) => {
      if (generation !== this.generation) {
        try { direct?.close() } catch { }
        reject(new RelayError(pick('与电脑的连接断开了', 'Disconnected from the desktop')))
        return
      }
      if (!direct && !this.config.join) {
        reject(new RelayError(pick('连不上电脑：请确认手机与电脑在同一网络（或同一个 Tailscale），电脑上的砚在运行', 'Cannot reach the desktop. Check that both devices share a network (or Tailscale) and Inkstone is running.')))
        return
      }
      const clientSecret = fromB64u(this.config.clientKey)
      const ephSecret = p256.utils.randomSecretKey()
      const ws = direct ?? new WebSocket(this.config.join!)
      this.ws = ws
      this.via = direct ? 'direct' : 'relay'
      let state: 'hello' | 'auth' | 'open' = 'hello'
      let timer: ReturnType<typeof setTimeout>
      const fail = (error: Error) => {
        clearTimeout(timer)
        if (this.ws !== ws) return
        if (state !== 'open') reject(error)
        this.teardown(error)
      }
      timer = setTimeout(() => fail(new RelayError(pick('连接电脑超时：请确认电脑上的砚在运行，并开启了中继接入', 'Timed out. Check that Inkstone is running with relay enabled.'))), HANDSHAKE_MS)
      const hello = () => {
        if (this.ws !== ws) return
        ws.send(JSON.stringify({ t: 'hi', v: PROTOCOL_VERSION, x: TEXT_PROTOCOL, c: toB64u(p256.getPublicKey(clientSecret, false)), e: toB64u(p256.getPublicKey(ephSecret, false)) }))
      }
      if (direct) hello()
      else ws.onopen = hello
      ws.onmessage = (event) => {
        if (this.ws !== ws) return
        const text = String(event.data)
        try {
          if (state === 'hello') {
            const hi = JSON.parse(text) as { t?: unknown; v?: unknown; e?: unknown }
            if (hi.t !== 'hi' || typeof hi.e !== 'string') throw new RelayError(pick('电脑的握手消息不对', 'Invalid handshake from desktop'))
            this.version = hi.v === TEXT_PROTOCOL ? TEXT_PROTOCOL : PROTOCOL_VERSION
            this.channel = clientChannel(clientSecret, ephSecret, fromB64u(this.config.hostKey), fromB64u(hi.e))
            state = 'auth'
            ws.send(this.channel.seal({ t: 'auth', name: this.deviceName, ...(pairCode ? { pair: pairCode } : {}) }))
            return
          }
          const msg = this.channel!.open(text)
          if (state === 'auth') {
            if (msg.t === 'denied') throw new RelayError(String(msg.reason ?? pick('电脑拒绝了连接', 'Desktop refused the connection')), true)
            if (msg.t !== 'welcome') throw new RelayError(pick('电脑的回应不对', 'Invalid response from desktop'))
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
      ws.onerror = () => fail(new RelayError(direct ? pick('与电脑的连接断开了', 'Disconnected from the desktop') : pick('连不上中继：请检查手机网络', 'Cannot reach relay. Check your phone network.')))
      ws.onclose = (event) => fail(new RelayError(event.code === 4004 ? pick('电脑不在线：请确认电脑开机、砚在运行并开启了中继接入', 'Desktop offline. Check that it is on, Inkstone is running and relay is enabled.') : pick('与电脑的连接断开了', 'Disconnected from the desktop')))
    }))
    const ready = attempt.catch((error: unknown) => {
      if (this.ready === ready) this.teardown(error instanceof Error ? error : new RelayError(String(error)))
      throw error
    })
    this.ready = ready
    return ready
  }

  private teardown(error: Error): void {
    const ws = this.ws
    this.generation++
    this.ws = null
    this.channel = null
    this.ready = null
    try {
      ws?.close()
    } catch {
    }
    for (const p of this.pending.values()) p.reject(error)
    this.pending.clear()
  }

  reset(): void {
    this.teardown(new RelayError(pick('与电脑的连接断开了', 'Disconnected from the desktop')))
  }

  close(): void {
    this.teardown(new RelayError(pick('连接已关闭', 'Connection closed')))
    for (const [key, value] of RelayTunnel.shared) if (value === this) RelayTunnel.shared.delete(key)
  }

  private frame(msg: Record<string, unknown>): void {
    const id = typeof msg.id === 'string' ? msg.id : ''
    const p = this.pending.get(id)
    if (!p) return
    try {
    if (msg.t === 'res') {
      p.status = Number(msg.status)
      p.headers = (msg.headers ?? {}) as Record<string, string>
      p.onStart?.(p.status)
      if (this.pending.get(id) !== p) return
      if (msg.stream) {
        p.stream = true
        return
      }
      this.pending.delete(id)
      p.resolve(new TunnelResponse(p.status, p.headers, typeof msg.text === 'string' ? { text: msg.text } : typeof msg.body === 'string' ? { base64: msg.body } : {}))
    } else if (msg.t === 'chunk' && typeof msg.text === 'string') {
      if (p.onText) p.onText(msg.text)
      else p.texts.push(msg.text)
    } else if (msg.t === 'chunk' && typeof msg.data === 'string') {
      const bytes = fromB64(msg.data)
      if (p.onChunk) p.onChunk(bytes)
      else p.chunks.push(bytes)
    } else if (msg.t === 'end') {
      this.pending.delete(id)
      if (typeof msg.error === 'string') p.reject(new RelayError(msg.error))
      else p.resolve(new TunnelResponse(p.status ?? 502, p.headers ?? {}, p.texts.length && !p.chunks.length ? { text: p.texts.join('') } : { bytes: concat(...p.chunks) }))
    }
    } catch (error) {
      this.pending.delete(id)
      p.reject(error instanceof Error ? error : new RelayError(String(error)))
    }
  }

  private async send(frame: Record<string, unknown> | (() => Record<string, unknown>)): Promise<void> {
    await this.connect()
    if (!this.ws || !this.channel) throw new RelayError(pick('与电脑的连接断开了', 'Disconnected from the desktop'))
    this.ws.send(this.channel.seal(typeof frame === 'function' ? frame() : frame))
  }

  async request(method: 'GET' | 'POST', path: string, init: { headers?: Record<string, string>; body?: string; timeoutMs?: number } = {}): Promise<TunnelResponse> {
    const id = `m${++this.seq}`
    const result = new Promise<TunnelResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        void this.send({ t: 'abort', id }).catch(() => undefined)
        reject(new RelayError(pick('连接超时：请确认电脑上的砚在运行', 'Timed out. Check that Inkstone is running on the desktop.')))
      }, init.timeoutMs ?? 20_000)
      this.pending.set(id, {
        resolve: (r) => { clearTimeout(timer); resolve(r) },
        reject: (e) => { clearTimeout(timer); reject(e) },
        chunks: [],
        texts: [],
        stream: false
      })
    })
    try {
      const body = init.body
      await this.send(() => ({ t: 'req', id, method, path, headers: init.headers ?? {}, ...(body === undefined ? {} : this.version >= TEXT_PROTOCOL ? { text: body } : { body: toB64(utf8ToBytes(body)) }) }))
    } catch (error) {
      this.pending.get(id)?.reject(error instanceof Error ? error : new RelayError(String(error)))
      this.pending.delete(id)
    }
    return result
  }

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
      texts: [],
      stream: true,
      onStart: handlers.onStart,
      onText: (text) => {
        if (text) handlers.onChunk(text)
      },
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
