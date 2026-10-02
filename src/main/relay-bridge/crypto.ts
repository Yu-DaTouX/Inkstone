/**
 * 中继通道的端到端加密：P-256 三重 ECDH 握手 + HKDF-SHA256 + AES-256-GCM 计数帧。
 *
 * 与礁石（Reef）App 协议逐字一致（礁石仓库 docs/specs/app.md「握手」），这样砚、礁石服务端、
 * 礁石 App、砚手机端可以共用同一个 Cloudflare 中继，中继只看到密文。这里独立实现，不依赖礁石代码。
 */
import { webcrypto } from 'node:crypto'

const subtle = webcrypto.subtle
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const CURVE = { name: 'ECDH', namedCurve: 'P-256' } as const
const LABEL = encoder.encode('reef-v1')
const INFO = encoder.encode('reef-v1 keys')

export const RELAY_PROTOCOL_VERSION = 1

export interface KeyPair {
  privateKey: webcrypto.CryptoKey
  publicKey: webcrypto.CryptoKey
  /** 65 字节未压缩公钥 */
  raw: Uint8Array
}

export function toB64u(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

export function fromB64u(text: string): Uint8Array {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('不是 base64url')
  return new Uint8Array(Buffer.from(text, 'base64url'))
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

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle.digest('SHA-256', bytes))
}

export function randomB64u(size: number): string {
  return toB64u(webcrypto.getRandomValues(new Uint8Array(size)))
}

export async function generateKeyPair(): Promise<KeyPair> {
  const pair = (await subtle.generateKey(CURVE, true, ['deriveBits'])) as webcrypto.CryptoKeyPair
  const raw = new Uint8Array(await subtle.exportKey('raw', pair.publicKey))
  return { privateKey: pair.privateKey, publicKey: pair.publicKey, raw }
}

export async function exportKeyPair(pair: KeyPair): Promise<webcrypto.JsonWebKey> {
  return subtle.exportKey('jwk', pair.privateKey)
}

export async function importKeyPair(jwk: webcrypto.JsonWebKey): Promise<KeyPair> {
  const privateKey = await subtle.importKey('jwk', jwk, CURVE, true, ['deriveBits'])
  const publicKey = await subtle.importKey('jwk', { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true }, CURVE, true, [])
  const raw = new Uint8Array(await subtle.exportKey('raw', publicKey))
  return { privateKey, publicKey, raw }
}

async function importPublic(raw: Uint8Array): Promise<webcrypto.CryptoKey> {
  if (!(raw instanceof Uint8Array) || raw.length !== 65 || raw[0] !== 4) throw new Error('公钥格式不对')
  return subtle.importKey('raw', raw, CURVE, true, [])
}

async function dh(privateKey: webcrypto.CryptoKey, publicKey: webcrypto.CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256))
}

async function finish(
  dh1: Uint8Array, dh2: Uint8Array, dh3: Uint8Array,
  serverStatic: Uint8Array, clientStatic: Uint8Array, clientEph: Uint8Array, serverEph: Uint8Array
): Promise<{ c2s: webcrypto.CryptoKey; s2c: webcrypto.CryptoKey }> {
  const salt = await sha256(concat(LABEL, serverStatic, clientStatic, clientEph, serverEph))
  const ikm = await subtle.importKey('raw', concat(dh1, dh2, dh3), 'HKDF', false, ['deriveBits'])
  const okm = new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: INFO }, ikm, 512))
  const key = (bytes: Uint8Array) => subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt'])
  return { c2s: await key(okm.slice(0, 32)), s2c: await key(okm.slice(32, 64)) }
}

/** 客户端一侧（测试与将来的桌面客户端用）。 */
export async function clientSession(input: { clientStatic: KeyPair; clientEph: KeyPair; serverStaticRaw: Uint8Array; serverEphRaw: Uint8Array }): Promise<SecureChannel> {
  const serverStatic = await importPublic(input.serverStaticRaw)
  const serverEph = await importPublic(input.serverEphRaw)
  const keys = await finish(
    await dh(input.clientEph.privateKey, serverEph),
    await dh(input.clientEph.privateKey, serverStatic),
    await dh(input.clientStatic.privateKey, serverEph),
    input.serverStaticRaw, input.clientStatic.raw, input.clientEph.raw, input.serverEphRaw
  )
  return new SecureChannel(keys.c2s, keys.s2c)
}

/** 主机一侧（砚）。 */
export async function serverSession(input: { serverStatic: KeyPair; serverEph: KeyPair; clientStaticRaw: Uint8Array; clientEphRaw: Uint8Array }): Promise<SecureChannel> {
  const clientStatic = await importPublic(input.clientStaticRaw)
  const clientEph = await importPublic(input.clientEphRaw)
  const keys = await finish(
    await dh(input.serverEph.privateKey, clientEph),
    await dh(input.serverStatic.privateKey, clientEph),
    await dh(input.serverEph.privateKey, clientStatic),
    input.serverStatic.raw, input.clientStaticRaw, input.clientEphRaw, input.serverEph.raw
  )
  return new SecureChannel(keys.s2c, keys.c2s)
}

function counterBytes(n: number): Uint8Array {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, BigInt(n))
  return out
}

/**
 * 一条连接上的加密通道。每个方向独立计数，IV = 4 字节 0 + 8 字节计数；
 * 接收方只接受恰好等于期望计数的帧，篡改、重放、乱序都会抛错（调用方应断开）。
 */
export class SecureChannel {
  private sendCount = 0
  private recvCount = 0
  private sendChain: Promise<unknown> = Promise.resolve()
  private recvChain: Promise<unknown> = Promise.resolve()

  constructor(private readonly sendKey: webcrypto.CryptoKey, private readonly recvKey: webcrypto.CryptoKey) {}

  seal(obj: unknown): Promise<string> {
    const n = this.sendCount++
    const job = this.sendChain.then(async () => {
      const ctr = counterBytes(n)
      const iv = concat(new Uint8Array(4), ctr)
      const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, this.sendKey, encoder.encode(JSON.stringify(obj))))
      return `x.${toB64u(concat(ctr, ct))}`
    })
    this.sendChain = job.catch(() => undefined)
    return job
  }

  open(frame: string): Promise<unknown> {
    const job = this.recvChain.then(async () => {
      if (typeof frame !== 'string' || !frame.startsWith('x.')) throw new Error('不是加密帧')
      const bytes = fromB64u(frame.slice(2))
      if (bytes.length < 8 + 16) throw new Error('加密帧太短')
      const ctr = bytes.slice(0, 8)
      const n = Number(new DataView(ctr.buffer).getBigUint64(0))
      if (n !== this.recvCount) throw new Error('加密帧计数不对（重放或乱序）')
      const iv = concat(new Uint8Array(4), ctr)
      const plain = await subtle.decrypt({ name: 'AES-GCM', iv }, this.recvKey, bytes.slice(8))
      this.recvCount++
      return JSON.parse(decoder.decode(plain)) as unknown
    })
    this.recvChain = job.catch(() => undefined)
    return job
  }
}
