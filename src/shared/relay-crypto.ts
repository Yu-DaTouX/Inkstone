import { pick } from './ui-lang'
export const RELAY_PROTOCOL_VERSION = 1

export interface RelayPrimitives {
  publicKey(secret: Uint8Array): Uint8Array
  ecdh(secret: Uint8Array, publicRaw: Uint8Array): Uint8Array
  sha256(bytes: Uint8Array): Uint8Array
  hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Uint8Array
  encrypt(key: Uint8Array, iv: Uint8Array, plain: Uint8Array): Uint8Array
  decrypt(key: Uint8Array, iv: Uint8Array, sealed: Uint8Array): Uint8Array
  utf8(text: string): Uint8Array
  text(bytes: Uint8Array): string
  toB64u(bytes: Uint8Array): string
  fromB64u(text: string): Uint8Array
}

export interface RelayKeys {
  send: Uint8Array
  recv: Uint8Array
}

export interface RelayFrameCodec {
  seal(key: Uint8Array, counter: number, text: string): string
  open(key: Uint8Array, frame: string, expected: number): string
}

const LABEL = 'reef-v1'
const INFO = 'reef-v1 keys'

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

export function checkRelayPublicKey(raw: Uint8Array): Uint8Array {
  if (!(raw instanceof Uint8Array) || raw.length !== 65 || raw[0] !== 4) throw new Error(pick('公钥格式不对', 'Invalid public key'))
  return raw
}

function schedule(p: RelayPrimitives, dh: Uint8Array[], hostRaw: Uint8Array, clientRaw: Uint8Array, clientEphRaw: Uint8Array, hostEphRaw: Uint8Array): { c2s: Uint8Array; s2c: Uint8Array } {
  const salt = p.sha256(concat(p.utf8(LABEL), hostRaw, clientRaw, clientEphRaw, hostEphRaw))
  const okm = p.hkdf(concat(...dh), salt, p.utf8(INFO), 64)
  return { c2s: okm.slice(0, 32), s2c: okm.slice(32, 64) }
}

export function relayClientKeys(p: RelayPrimitives, input: { clientSecret: Uint8Array; ephSecret: Uint8Array; hostRaw: Uint8Array; hostEphRaw: Uint8Array }): RelayKeys {
  const hostRaw = checkRelayPublicKey(input.hostRaw)
  const hostEphRaw = checkRelayPublicKey(input.hostEphRaw)
  const keys = schedule(p, [
    p.ecdh(input.ephSecret, hostEphRaw),
    p.ecdh(input.ephSecret, hostRaw),
    p.ecdh(input.clientSecret, hostEphRaw)
  ], hostRaw, p.publicKey(input.clientSecret), p.publicKey(input.ephSecret), hostEphRaw)
  return { send: keys.c2s, recv: keys.s2c }
}

export function relayServerKeys(p: RelayPrimitives, input: { hostSecret: Uint8Array; ephSecret: Uint8Array; clientRaw: Uint8Array; clientEphRaw: Uint8Array }): RelayKeys {
  const clientRaw = checkRelayPublicKey(input.clientRaw)
  const clientEphRaw = checkRelayPublicKey(input.clientEphRaw)
  const keys = schedule(p, [
    p.ecdh(input.ephSecret, clientEphRaw),
    p.ecdh(input.hostSecret, clientEphRaw),
    p.ecdh(input.ephSecret, clientRaw)
  ], p.publicKey(input.hostSecret), clientRaw, clientEphRaw, p.publicKey(input.ephSecret))
  return { send: keys.s2c, recv: keys.c2s }
}

function counterBytes(n: number): Uint8Array {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, BigInt(n))
  return out
}

export function relayFrameCodec(p: RelayPrimitives): RelayFrameCodec {
  return {
    seal(key, counter, text) {
      const ctr = counterBytes(counter)
      return `x.${p.toB64u(concat(ctr, p.encrypt(key, concat(new Uint8Array(4), ctr), p.utf8(text))))}`
    },
    open(key, frame, expected) {
      if (typeof frame !== 'string' || !frame.startsWith('x.')) throw new Error(pick('不是加密帧', 'Not an encrypted frame'))
      const bytes = p.fromB64u(frame.slice(2))
      if (bytes.length < 8 + 16) throw new Error(pick('加密帧太短', 'Encrypted frame too short'))
      const ctr = bytes.slice(0, 8)
      if (Number(new DataView(ctr.buffer).getBigUint64(0)) !== expected) throw new Error(pick('加密帧计数不对（重放或乱序）', 'Encrypted frame count mismatch (replayed or out of order)'))
      return p.text(p.decrypt(key, concat(new Uint8Array(4), ctr), bytes.slice(8)))
    }
  }
}

export class RelayChannel {
  private sendCount = 0
  private recvCount = 0

  constructor(private readonly keys: RelayKeys, private readonly codec: RelayFrameCodec) {}

  seal(obj: unknown): string {
    return this.codec.seal(this.keys.send, this.sendCount++, JSON.stringify(obj))
  }

  open(frame: string): Record<string, unknown> {
    const text = this.codec.open(this.keys.recv, frame, this.recvCount)
    this.recvCount++
    return JSON.parse(text) as Record<string, unknown>
  }
}
