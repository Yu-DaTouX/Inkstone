import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { isLinkLocalAddress, isMetadataAddress, normalizeAddressLiteral } from './address-policy'
import { isPrivateAddress } from '../browser/network-policy'

export type PinnedAddress = { address: string; family: 4 | 6 }

export type PinRejectReason =
  | 'invalid-host'
  | 'local-host'
  | 'not-public'
  | 'lookup-failed'
  | 'empty-answer'
  | 'timeout'
  | 'busy'
  | 'closed'

export class PinRejectedError extends Error {
  constructor(readonly reason: PinRejectReason) {
    super(`pinned lookup rejected: ${reason}`)
    this.name = 'PinRejectedError'
  }
}

export interface PublicPin {
  host: string
  addresses: PinnedAddress[]
  expiresAt: number
}

export interface PublicPinResolverOptions {
  resolve?: (hostname: string) => Promise<readonly { address: string; family: number }[]>
  ttlMs?: number
  limit?: number
  maxPending?: number
  timeoutMs?: number
  now?: () => number
}

export function isLoopbackAddress(raw: string): boolean {
  const address = normalizeAddressLiteral(raw)
  if (!address) return false
  if (isIP(address) === 4) return /^127\./.test(address)
  return address === '::1'
}

export function isPublicAddress(raw: string): boolean {
  const address = normalizeAddressLiteral(raw)
  if (!address) return false
  if (isLoopbackAddress(address)) return false
  if (isMetadataAddress(address) || isLinkLocalAddress(address)) return false
  return !isPrivateAddress(address)
}

export function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  return host === 'localhost' || host.endsWith('.localhost')
}

export function dialLiteral(raw: string): { address: string; family: 4 | 6 } | undefined {
  const address = raw.trim().replace(/^\[|\]$/g, '').split('%', 1)[0]
  const family = isIP(address)
  if (family === 4) return { address, family: 4 }
  if (family === 6) return { address: address.toLowerCase(), family: 6 }
  return undefined
}

export function normalizePinnedHost(hostname: string): string | undefined {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (!host || host.length > 253) return undefined
  if (host.includes('/') || host.includes('\\') || host.includes('@') || host.includes(' ')) return undefined
  const literal = dialLiteral(host)
  if (literal) return literal.address
  if (host.includes('..')) return undefined
  const labels = host.split('.')
  if (labels.some((label) => !/^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/.test(label))) return undefined
  return host
}

function toPinnedAddresses(records: readonly { address: string; family: number }[]): PinnedAddress[] | undefined {
  const seen = new Set<string>()
  const out: PinnedAddress[] = []
  for (const record of records) {
    const literal = dialLiteral(record.address)
    if (!literal) return undefined
    if (!isPublicAddress(record.address)) return undefined
    const key = `${literal.family}:${literal.address}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(literal)
  }
  return out.length ? out : undefined
}

export class PublicPinResolver {
  private readonly resolveHost: (hostname: string) => Promise<readonly { address: string; family: number }[]>
  private readonly ttlMs: number
  private readonly limit: number
  private readonly now: () => number
  private readonly maxPending: number
  private readonly timeoutMs: number
  private readonly pins = new Map<string, PublicPin>()
  private readonly pending = new Map<string, Promise<PublicPin>>()
  private generation = 0
  private closed = false

  constructor(options: PublicPinResolverOptions = {}) {
    this.resolveHost = options.resolve ?? ((hostname) => lookup(hostname, { all: true, verbatim: true }))
    this.ttlMs = options.ttlMs ?? 30_000
    this.limit = options.limit ?? 256
    this.maxPending = options.maxPending ?? 64
    this.timeoutMs = options.timeoutMs ?? 5_000
    this.now = options.now ?? (() => Date.now())
  }

  resolve(hostname: string): Promise<PublicPin> {
    if (this.closed) return Promise.reject(new PinRejectedError('closed'))
    let host: string
    try {
      host = this.validate(hostname)
    } catch (error) {
      return Promise.reject(error)
    }
    const cached = this.pins.get(host)
    if (cached && cached.expiresAt > this.now()) return Promise.resolve(cached)
    if (cached) this.pins.delete(host)
    const inFlight = this.pending.get(host)
    if (inFlight) return this.wait(inFlight)
    if (this.pending.size >= this.maxPending) return Promise.reject(new PinRejectedError('busy'))
    const generation = this.generation
    const request = this.pin(host)
      .then((pin) => {
        if (generation === this.generation) this.remember(host, pin)
        return pin
      })
      .finally(() => {
        if (this.pending.get(host) === request) this.pending.delete(host)
      })
    this.pending.set(host, request)
    return this.wait(request)
  }

  clear(): void {
    this.generation += 1
    this.pins.clear()
  }

  close(): void {
    this.closed = true
    this.clear()
  }

  private wait(task: Promise<PublicPin>): Promise<PublicPin> {
    return new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new PinRejectedError('timeout'))
      }, this.timeoutMs)
      task.then(
        (pin) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(pin)
        },
        (error) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(error)
        }
      )
    })
  }

  private validate(raw: string): string {
    const host = normalizePinnedHost(raw)
    if (!host) throw new PinRejectedError('invalid-host')
    if (isLocalHostname(host)) throw new PinRejectedError('local-host')
    if (isIP(host)) {
      if (!isPublicAddress(host)) throw new PinRejectedError('not-public')
    }
    return host
  }

  private async pin(host: string): Promise<PublicPin> {
    const literal = dialLiteral(host)
    if (literal) {
      const addresses = toPinnedAddresses([{ address: literal.address, family: literal.family }])
      if (!addresses) throw new PinRejectedError('not-public')
      return { host, addresses, expiresAt: this.now() + this.ttlMs }
    }
    let records: readonly { address: string; family: number }[]
    try {
      records = await this.resolveHost(host)
    } catch {
      throw new PinRejectedError('lookup-failed')
    }
    if (!records.length) throw new PinRejectedError('empty-answer')
    const addresses = toPinnedAddresses(records)
    if (!addresses) throw new PinRejectedError('not-public')
    return { host, addresses, expiresAt: this.now() + this.ttlMs }
  }

  private remember(host: string, pin: PublicPin): void {
    if (this.pins.size >= this.limit) {
      const now = this.now()
      for (const [key, entry] of this.pins) if (entry.expiresAt <= now) this.pins.delete(key)
      for (const key of this.pins.keys()) {
        if (this.pins.size < this.limit) break
        this.pins.delete(key)
      }
    }
    this.pins.set(host, pin)
  }
}
