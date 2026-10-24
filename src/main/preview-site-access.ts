import { isIP } from 'node:net'
import { isLinkLocalHost } from './browser/network-boundary'

export type SiteDecision = 'allow' | 'deny' | 'ask' | 'forbidden' | 'invalid'
export type SiteAddResult = 'ok' | 'invalid' | 'exists' | 'blocked' | 'unavailable'

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

export const MAX_ALLOWED_SITES = 500

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

export function allowedSiteList(saved: unknown): string[] {
  const out: string[] = []
  for (const value of Array.isArray(saved) ? saved : []) {
    if (typeof value !== 'string') continue
    const origin = normalizeSiteOrigin(value)
    if (!origin || origin !== value.trim() || out.includes(origin) || isForbiddenOrigin(origin)) continue
    out.push(origin)
    if (out.length >= MAX_ALLOWED_SITES) break
  }
  return out
}

function withScheme(value: string): string {
  return /^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`
}

export function addAllowedSite(
  saved: unknown,
  value: string
): { result: SiteAddResult; list: string[]; origin?: string } {
  const list = allowedSiteList(saved)
  const raw = String(value ?? '').trim()
  if (!raw) return { result: 'invalid', list }
  const origin = normalizeSiteOrigin(withScheme(raw))
  if (!origin) return { result: 'invalid', list }
  const host = hostOfOrigin(origin)
  if (!host.includes('.') && !host.includes(':') && host !== 'localhost') return { result: 'invalid', list }
  if (isForbiddenOrigin(origin)) return { result: 'blocked', list }
  if (list.includes(origin)) return { result: 'exists', list }
  if (list.length >= MAX_ALLOWED_SITES) return { result: 'unavailable', list }
  return { result: 'ok', list: [...list, origin], origin }
}

export function removeAllowedSite(
  saved: unknown,
  value: string
): { removed: boolean; list: string[]; origin: string } {
  const list = allowedSiteList(saved)
  const raw = String(value ?? '').trim()
  const origin = normalizeSiteOrigin(raw) ?? raw
  if (!list.includes(origin)) return { removed: false, list, origin }
  return { removed: true, list: list.filter((entry) => entry !== origin), origin }
}

export interface SiteAccessStore {
  load(): string[] | Promise<string[]>
  save(list: string[]): void
}

export class PreviewSiteAccess {
  private allowed: string[]
  private loaded: boolean
  private loading: Promise<void> | null = null

  constructor(
    private readonly store?: SiteAccessStore,
    private readonly limit = MAX_ALLOWED_SITES
  ) {
    this.allowed = []
    this.loaded = !store
  }

  async ready(): Promise<void> {
    if (this.loaded || !this.store) return
    const store = this.store
    this.loading ??= (async () => {
      try {
        this.allowed = allowedSiteList(await store.load()).slice(0, this.limit)
      } catch {
        this.allowed = []
      }
      this.loaded = true
    })()
    return this.loading
  }

  sites(): string[] {
    return [...this.allowed]
  }

  decide(_sessionId: string, url: string): { decision: SiteDecision; origin: string | null } {
    const origin = normalizeSiteOrigin(url)
    if (!origin) return { decision: 'invalid', origin: null }
    if (isForbiddenOrigin(origin)) return { decision: 'forbidden', origin }
    if (this.allowed.includes(origin)) return { decision: 'allow', origin }
    return { decision: 'ask', origin }
  }

  record(sessionId: string, url: string, allowed: boolean): SiteDecision {
    const verdict = this.decide(sessionId, url)
    if (!verdict.origin) return verdict.decision
    if (verdict.decision === 'forbidden' || verdict.decision === 'invalid') return verdict.decision
    if (!allowed) return 'deny'
    if (verdict.decision === 'allow') return 'allow'
    const added = addAllowedSite(this.allowed, verdict.origin)
    if (added.result !== 'ok' || added.list.length > this.limit) return 'deny'
    this.persist(added.list)
    return 'allow'
  }

  add(value: string): { result: SiteAddResult; list: string[]; origin?: string } {
    const added = addAllowedSite(this.allowed, value)
    if (added.result !== 'ok') return added
    if (added.list.length > this.limit) return { result: 'unavailable', list: this.sites() }
    this.persist(added.list)
    return added
  }

  remove(value: string): { removed: boolean; list: string[] } {
    const removed = removeAllowedSite(this.allowed, value)
    if (!removed.removed) return { removed: false, list: removed.list }
    this.persist(removed.list)
    return { removed: true, list: removed.list }
  }

  clear(): string[] {
    this.persist([])
    return []
  }

  private persist(list: string[]): void {
    this.allowed = allowedSiteList(list).slice(0, this.limit)
    try {
      this.store?.save(this.sites())
    } catch {
    }
  }
}
