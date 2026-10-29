import { SEARCH_QUERIES_MAX, type SearchModifiers, type SearchSourceId } from '../../shared/search'
import { detectLocale, isSearchRecency, normalizeSites } from './modifiers'
import type { SearchPolicy } from './search'

export interface SearchKeys {
  tavily: boolean
  brave: boolean
  deepseek: boolean
}

export const PRIMARY_GRACE_MS = 2500
export const PRIMARY_ENOUGH_ROWS = 3

const PAID_ORDER: Record<'zh' | 'en', readonly ('deepseek' | 'tavily' | 'brave')[]> = {
  zh: ['deepseek', 'tavily', 'brave'],
  en: ['tavily', 'brave', 'deepseek']
}
const WEB: SearchSourceId = 'ddg'

export function defaultSearchPlan(text: string, keys: SearchKeys, opts: SearchModifiers = {}): { sources: SearchSourceId[]; policy?: SearchPolicy } {
  const paid = PAID_ORDER[opts.language?.startsWith('zh') ? 'zh' : opts.language ? 'en' : detectLocale(text)].filter((id) => keys[id])
  if (opts.coverage === 'broad') return { sources: [...paid, WEB] }
  const settle = { enoughRows: PRIMARY_ENOUGH_ROWS, graceMs: PRIMARY_GRACE_MS }
  if (paid.length === 0) return { sources: [WEB], policy: { primary: [WEB], reserve: [], ...settle } }
  return { sources: [paid[0], WEB], policy: { primary: [paid[0]], reserve: paid.slice(1), ...settle } }
}

export function searchQueries(params: Record<string, unknown>): string[] {
  const raw = [params['query-text'], params.queryText, params.queries, params.query, params.text].find(
    (value) => (typeof value === 'string' && value.trim()) || (Array.isArray(value) && value.length)
  )
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []
  const queries: string[] = []
  for (const item of list) {
    const text = typeof item === 'string' ? item.trim() : ''
    if (text && !queries.includes(text)) queries.push(text)
  }
  return queries
}

export function tooManyQueries(queries: readonly string[]): boolean {
  return queries.length > SEARCH_QUERIES_MAX
}

const truthy = (value: unknown): boolean => value === true || value === 'true' || value === '1' || value === 'yes'

export function searchModifiers(params: Record<string, unknown>): { ok: true; modifiers: SearchModifiers } | { ok: false; code: string; message: string } {
  const modifiers: SearchModifiers = {}
  const recent = typeof params.recent === 'string' ? params.recent.trim().toLowerCase() : params.recent
  if (recent !== undefined && recent !== '') {
    if (!isSearchRecency(recent)) return { ok: false, code: 'search_bad_recent', message: '--recent 只能是 day、week、month 或 year' }
    modifiers.recent = recent
  }
  const rawSites = params.sites ?? params.site
  if (rawSites !== undefined && rawSites !== true) {
    const { sites, rejected } = normalizeSites(rawSites)
    if (rejected.length) return { ok: false, code: 'search_bad_site', message: `不是合法的站点域名：${rejected.join('、')}` }
    if (sites.length) modifiers.sites = sites
  }
  const question = typeof params.question === 'string' ? params.question.trim() : ''
  if (question) modifiers.question = question
  if (truthy(params['with-content'] ?? params.withContent)) modifiers.withContent = true
  const excluded = params.excludeSites ?? params['exclude-sites']
  if (excluded !== undefined) {
    const parsed = normalizeSites(excluded)
    if (parsed.rejected.length) return { ok: false, code: 'search_bad_site', message: `不是合法的排除站点：${parsed.rejected.join('、')}` }
    if (parsed.sites.length) modifiers.excludeSites = parsed.sites
  }
  for (const key of ['after', 'before'] as const) {
    const raw = params[key]
    if (raw === undefined || raw === '') continue
    if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw) || !Number.isFinite(Date.parse(raw)) || new Date(raw).toISOString().slice(0, 10) !== raw) return { ok: false, code: 'search_bad_date', message: `${key} 必须是有效的 YYYY-MM-DD 日期` }
    modifiers[key] = raw
  }
  if (modifiers.after && modifiers.before && modifiers.after > modifiers.before) return { ok: false, code: 'search_bad_date', message: 'after 不能晚于 before' }
  for (const key of ['language', 'country'] as const) {
    const raw = params[key]
    if (raw === undefined || raw === '') continue
    if (typeof raw !== 'string' || !(key === 'country' ? /^[a-z]{2}$/i : /^[a-z]{2,3}(?:-[a-z]{2,4})?$/i).test(raw)) return { ok: false, code: 'search_bad_locale', message: `${key} 不是合法的语言或国家代码` }
    modifiers[key] = key === 'country' ? raw.toUpperCase() : raw.toLowerCase()
  }
  if (params.coverage !== undefined) {
    if (params.coverage !== 'fast' && params.coverage !== 'broad') return { ok: false, code: 'search_bad_coverage', message: 'coverage 只能是 fast 或 broad' }
    modifiers.coverage = params.coverage
  }
  return { ok: true, modifiers }
}

export class TtlCache<T> {
  private readonly entries = new Map<string, { at: number; value: T }>()
  private readonly pending = new Map<string, { promise: Promise<T>; controller: AbortController; users: number }>()

  constructor(
    private readonly ttlMs: number,
    private readonly max: number,
    private readonly now: () => number = Date.now
  ) {}

  get(key: string): T | undefined {
    const hit = this.entries.get(key)
    if (!hit) return undefined
    if (this.now() - hit.at > this.ttlMs) {
      this.entries.delete(key)
      return undefined
    }
    this.entries.delete(key)
    this.entries.set(key, hit)
    return hit.value
  }

  async getOrLoad(
    key: string,
    load: (signal: AbortSignal) => Promise<T>,
    options: { refresh?: boolean; accept?: (value: T) => boolean; signal?: AbortSignal } = {}
  ): Promise<{ value: T; cached: boolean }> {
    options.signal?.throwIfAborted()
    const cached = options.refresh ? undefined : this.get(key)
    if (cached !== undefined) return { value: cached, cached: true }
    let entry = this.pending.get(key)
    if (!entry || entry.controller.signal.aborted) {
      const controller = new AbortController()
      const created = { promise: undefined as unknown as Promise<T>, controller, users: 0 }
      created.promise = Promise.resolve().then(() => load(controller.signal)).then((value) => {
        if (!controller.signal.aborted && (!options.accept || options.accept(value))) this.set(key, value)
        return value
      }).finally(() => { if (this.pending.get(key) === created) this.pending.delete(key) })
      entry = created
      this.pending.set(key, entry)
    }
    const pending = entry
    pending.users++
    let onAbort: (() => void) | undefined
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(options.signal?.reason ?? new Error('cancelled'))
      options.signal?.addEventListener('abort', onAbort, { once: true })
      if (options.signal?.aborted) onAbort()
    })
    try {
      return { value: await Promise.race([pending.promise, cancelled]), cached: false }
    } finally {
      if (onAbort) options.signal?.removeEventListener('abort', onAbort)
      if (--pending.users === 0) {
        pending.controller.abort()
        if (this.pending.get(key) === pending) this.pending.delete(key)
      }
    }
  }

  set(key: string, value: T): void {
    this.entries.delete(key)
    this.entries.set(key, { at: this.now(), value })
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value as string)
  }
}

export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      out[index] = await fn(items[index])
    }
  })
  await Promise.all(workers)
  return out
}
