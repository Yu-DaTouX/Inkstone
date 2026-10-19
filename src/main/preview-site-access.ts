import { isIP } from 'node:net'
import { isLinkLocalHost } from './browser/network-boundary'

export type SiteDecision = 'allow' | 'deny' | 'ask' | 'forbidden' | 'invalid'

const FORBIDDEN_HOSTS = new Set([
  '169.254.169.254',
  '169.254.170.2',
  '100.100.100.200',
  '0.0.0.0',
  '[::]',
  '[fd00:ec2::254]',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'metadata.azure.com',
  'instance-data',
  'instance-data.ec2.internal'
])

const MAX_ORIGINS_PER_SESSION = 500

function mappedIpv4(host: string): string | null {
  const inner = host.replace(/^\[|\]$/g, '').toLowerCase()
  const dotted = /^(?:0{0,4}:){0,5}:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(inner)
  if (dotted && isIP(dotted[1]) === 4) return dotted[1]
  const hex = /^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(inner)
  if (!hex) return null
  const high = parseInt(hex[1], 16)
  const low = parseInt(hex[2], 16)
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
}

export function normalizeSiteOrigin(raw: string): string | null {
  let url: URL
  try {
    url = new URL(String(raw ?? '').trim())
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  let host = url.hostname.toLowerCase().replace(/\.+$/, '')
  if (!host) return null
  const mapped = host.startsWith('[') ? mappedIpv4(host) : null
  if (mapped) host = mapped
  const bare = host.replace(/^\[|\]$/g, '')
  if (!isIP(bare) && host.startsWith('www.') && host.split('.').length >= 3) host = host.slice(4)
  const port = url.port ? `:${url.port}` : ''
  return `${url.protocol}//${host}${port}`
}

export function hostOfOrigin(origin: string): string {
  const withoutScheme = origin.replace(/^https?:\/\//, '')
  if (withoutScheme.startsWith('[')) return withoutScheme.slice(0, withoutScheme.indexOf(']') + 1)
  return withoutScheme.replace(/:\d+$/, '')
}

export function isForbiddenOrigin(origin: string): boolean {
  const host = hostOfOrigin(origin)
  return FORBIDDEN_HOSTS.has(host) || isLinkLocalHost(host)
}

export class PreviewSiteAccess {
  private readonly sessions = new Map<string, Map<string, boolean>>()

  constructor(private readonly limitPerSession = MAX_ORIGINS_PER_SESSION) {}

  decide(sessionId: string, url: string): { decision: SiteDecision; origin: string | null } {
    const origin = normalizeSiteOrigin(url)
    if (!origin) return { decision: 'invalid', origin: null }
    if (isForbiddenOrigin(origin)) return { decision: 'forbidden', origin }
    const remembered = this.sessions.get(sessionId)?.get(origin)
    if (remembered === undefined) return { decision: 'ask', origin }
    return { decision: remembered ? 'allow' : 'deny', origin }
  }

  record(sessionId: string, url: string, allowed: boolean): SiteDecision {
    const origin = normalizeSiteOrigin(url)
    if (!origin) return 'invalid'
    if (isForbiddenOrigin(origin)) return 'forbidden'
    let table = this.sessions.get(sessionId)
    if (!table) {
      table = new Map()
      this.sessions.set(sessionId, table)
    }
    if (!table.has(origin) && table.size >= this.limitPerSession) {
      const oldest = table.keys().next().value
      if (oldest !== undefined) table.delete(oldest)
    }
    if (table.get(origin) === false) return 'deny'
    table.set(origin, allowed)
    return allowed ? 'allow' : 'deny'
  }

  forgetSession(sessionId: string): void {
    this.sessions.delete(sessionId)
  }
}
