import { SEARCH_RECENCIES, SEARCH_SITES_MAX, type SearchModifiers, type SearchRecency, type SearchSourceId } from '../../shared/search'

export interface SourceRequest extends SearchModifiers {
  limit: number
  timeoutMs: number
  signal?: AbortSignal
}

export const RECENCY_SOURCES: ReadonlySet<SearchSourceId> = new Set(['bing', 'ddg', 'brave', 'tavily', 'deepseek'])

export function siteMatches(url: string, sites: readonly string[]): boolean {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return false
  }
  return sites.some((site) => host === site || host.endsWith('.' + site))
}

export type SearchLocale = 'zh' | 'en'

export function detectLocale(query: string): SearchLocale {
  return /[぀-ヿ㐀-鿿가-힯]/.test(query) ? 'zh' : 'en'
}

const RECENCY_DAYS: Record<SearchRecency, number> = { day: 1, week: 7, month: 31, year: 366 }
const DAY_MS = 86_400_000

export function isSearchRecency(value: unknown): value is SearchRecency {
  return SEARCH_RECENCIES.includes(value as SearchRecency)
}

export function recencySince(recent: SearchRecency, now = Date.now()): Date {
  return new Date(now - RECENCY_DAYS[recent] * DAY_MS)
}

export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

export function daysSinceEpoch(date: Date): number {
  return Math.floor(date.getTime() / DAY_MS)
}

export function normalizeSite(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase()
  if (!trimmed) return null
  let host = trimmed
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`).hostname
  } catch {
    return null
  }
  host = host.replace(/^www\./, '')
  return /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) ? host : null
}

export function normalizeSites(input: unknown): { sites: string[]; rejected: string[] } {
  const raw = Array.isArray(input) ? input.map(String) : typeof input === 'string' ? input.split(/[,\s]+/) : []
  const sites: string[] = []
  const rejected: string[] = []
  for (const item of raw) {
    if (!item.trim()) continue
    const site = normalizeSite(item)
    if (!site) rejected.push(item.trim())
    else if (!sites.includes(site) && sites.length < SEARCH_SITES_MAX) sites.push(site)
  }
  return { sites, rejected }
}

export function siteOperator(sites: readonly string[] | undefined): string {
  if (!sites?.length) return ''
  return sites.length === 1 ? `site:${sites[0]}` : `(${sites.map((s) => `site:${s}`).join(' OR ')})`
}

export function withOperators(query: string, operators: readonly string[], maxChars = Infinity): string {
  const suffix = operators.filter(Boolean).join(' ')
  if (!suffix) return Array.from(query.trim()).slice(0, maxChars).join('')
  const room = Math.max(1, maxChars - Array.from(suffix).length - 1)
  return `${Array.from(query.trim()).slice(0, room).join('')} ${suffix}`
}
