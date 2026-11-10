import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { embeddedIpv4, inIpv6Range, parseIpv6Literal } from '../net/address-policy'

export function isPrivateAddress(raw: string): boolean {
  const address = raw.trim().replace(/^\[|\]$/g, '').split('%', 1)[0]
  const kind = isIP(address)
  if (kind === 4) return isPrivateIpv4(address)
  if (kind !== 6) return false

  const value = parseIpv6Literal(address)
  if (value === null) return false
  const embedded = embeddedIpv4(value)
  if (embedded) return isPrivateIpv4(embedded)

  return value >> 32n === 0n || inIpv6Range(value, 0xfc000000000000000000000000000000n, 7) ||
    inIpv6Range(value, 0xfe800000000000000000000000000000n, 10) || inIpv6Range(value, 0xff000000000000000000000000000000n, 8)
}

export async function resolvesToPrivateAddress(hostname: string): Promise<boolean> {
  try {
    return await resolvesToPrivateAddressStrict(hostname)
  } catch {
    return false
  }
}

export async function resolvesToPrivateAddressStrict(hostname: string): Promise<boolean> {
  const value = hostname.trim().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (isPrivateAddress(value)) return true
  if (!value || isIP(value)) return false
  const records = await lookup(value, { all: true, verbatim: true })
  return records.some((record) => isPrivateAddress(record.address))
}

export class PrivateDnsGuard {
  private readonly cache = new Map<string, { private: boolean; expiresAt: number }>()
  private readonly pending = new Map<string, Promise<boolean>>()

  constructor(
    private readonly resolve: (hostname: string) => Promise<boolean> = resolvesToPrivateAddress,
    private readonly ttlMs = 10_000,
    private readonly limit = 200
  ) {}

  resolves(hostname: string): Promise<boolean> {
    const key = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
    const cached = this.cache.get(key)
    if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.private)
    const inFlight = this.pending.get(key)
    if (inFlight) return inFlight
    const lookupOnce = this.resolve(key)
      .catch(() => false)
      .then((isPrivate) => {
        this.remember(key, isPrivate)
        return isPrivate
      })
      .finally(() => this.pending.delete(key))
    this.pending.set(key, lookupOnce)
    return lookupOnce
  }

  private remember(key: string, isPrivate: boolean): void {
    const now = Date.now()
    if (this.cache.size >= this.limit) {
      for (const [host, entry] of this.cache) if (entry.expiresAt <= now) this.cache.delete(host)
      for (const host of this.cache.keys()) {
        if (this.cache.size < this.limit) break
        this.cache.delete(host)
      }
    }
    this.cache.set(key, { private: isPrivate, expiresAt: now + this.ttlMs })
  }
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split('.').map((part) => Number(part))
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b] = octets
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  )
}
