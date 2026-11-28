import { createCipheriv, createDecipheriv, createECDH, createHash, hkdfSync, randomBytes, type JsonWebKey } from 'node:crypto'
import { decodeBase64Url as fromB64u, encodeBase64Url as toB64u } from '../../shared/base64url'
import { RELAY_PROTOCOL_VERSION, RelayChannel, relayClientKeys, relayFrameCodec, relayServerKeys, type RelayPrimitives } from '../../shared/relay-crypto'

export { RELAY_PROTOCOL_VERSION, fromB64u, toB64u }

export interface KeyPair {
  secret: Uint8Array
  raw: Uint8Array
}

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: false })

function curve(secret: Uint8Array) {
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(secret)
  return ecdh
}

export const nodeRelayPrimitives: RelayPrimitives = {
  publicKey: (secret) => new Uint8Array(curve(secret).getPublicKey(null, 'uncompressed')),
  ecdh: (secret, publicRaw) => new Uint8Array(curve(secret).computeSecret(publicRaw)),
  sha256: (bytes) => new Uint8Array(createHash('sha256').update(bytes).digest()),
  hkdf: (ikm, salt, info, length) => new Uint8Array(hkdfSync('sha256', ikm, salt, info, length)),
  encrypt(key, iv, plain) {
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()])
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
  },
  decrypt(key, iv, sealed) {
    if (sealed.length < 16) throw new Error('加密帧太短')
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(sealed.subarray(sealed.length - 16))
    const body = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()])
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
  },
  utf8: (text) => encoder.encode(text),
  text: (bytes) => decoder.decode(bytes),
  toB64u,
  fromB64u
}

const codec = relayFrameCodec(nodeRelayPrimitives)

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return nodeRelayPrimitives.sha256(bytes)
}

export function randomB64u(size: number): string {
  return toB64u(randomBytes(size))
}

function fromSecret(secret: Uint8Array): KeyPair {
  return { secret, raw: nodeRelayPrimitives.publicKey(secret) }
}

export async function generateKeyPair(): Promise<KeyPair> {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const key = ecdh.getPrivateKey()
  const secret = new Uint8Array(32)
  secret.set(key, 32 - key.length)
  return fromSecret(secret)
}

export async function exportKeyPair(pair: KeyPair): Promise<JsonWebKey> {
  return { kty: 'EC', crv: 'P-256', d: toB64u(pair.secret), x: toB64u(pair.raw.subarray(1, 33)), y: toB64u(pair.raw.subarray(33, 65)), ext: true }
}

export async function importKeyPair(jwk: JsonWebKey): Promise<KeyPair> {
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.d !== 'string') throw new Error('密钥格式不对')
  const pair = fromSecret(fromB64u(jwk.d))
  if ((jwk.x && jwk.x !== toB64u(pair.raw.subarray(1, 33))) || (jwk.y && jwk.y !== toB64u(pair.raw.subarray(33, 65)))) throw new Error('密钥格式不对')
  return pair
}

export class SecureChannel {
  constructor(private readonly channel: RelayChannel) {}

  seal(obj: unknown): Promise<string> {
    try {
      return Promise.resolve(this.channel.seal(obj))
    } catch (error) {
      return Promise.reject(error)
    }
  }

  open(frame: string): Promise<unknown> {
    try {
      return Promise.resolve(this.channel.open(frame))
    } catch (error) {
      return Promise.reject(error)
    }
  }
}

export async function clientSession(input: { clientStatic: KeyPair; clientEph: KeyPair; serverStaticRaw: Uint8Array; serverEphRaw: Uint8Array }): Promise<SecureChannel> {
  const keys = relayClientKeys(nodeRelayPrimitives, { clientSecret: input.clientStatic.secret, ephSecret: input.clientEph.secret, hostRaw: input.serverStaticRaw, hostEphRaw: input.serverEphRaw })
  return new SecureChannel(new RelayChannel(keys, codec))
}

export async function serverSession(input: { serverStatic: KeyPair; serverEph: KeyPair; clientStaticRaw: Uint8Array; clientEphRaw: Uint8Array }): Promise<SecureChannel> {
  const keys = relayServerKeys(nodeRelayPrimitives, { hostSecret: input.serverStatic.secret, ephSecret: input.serverEph.secret, clientRaw: input.clientStaticRaw, clientEphRaw: input.clientEphRaw })
  return new SecureChannel(new RelayChannel(keys, codec))
}
