import type { SourceRun } from './aggregate'
import type { SearchRecency } from '../../shared/search'
import { resolveBraveKey } from './config'
import { queryOperators, withOperators, type SourceRequest } from './modifiers'

const ENDPOINT = 'https://api.search.brave.com/res/v1/web/search'
const BRAVE_FRESHNESS: Record<SearchRecency, string> = { day: 'pd', week: 'pw', month: 'pm', year: 'py' }

function stripTags(input: unknown): string {
  return typeof input === 'string' ? input.replace(/<[^>]*>/g, '') : ''
}

export async function runBraveSearch(query: string, opts: SourceRequest, fetchImpl: typeof fetch = fetch): Promise<SourceRun> {
  const started = Date.now()
  const elapsed = (): number => Date.now() - started
  const key = await resolveBraveKey()
  if (!key) {
    return {
      source: 'brave',
      rows: null,
      unavailable: true,
      error: { code: 'api_key_missing', message: '未配置 Brave Search API key（设置 → 能力 → 外部工具）' },
      elapsedMs: 0
    }
  }
  const url = new URL(ENDPOINT)
  url.searchParams.set('q', withOperators(query, queryOperators({ ...opts, language: undefined, after: undefined, before: undefined })))
  url.searchParams.set('count', String(Math.min(20, Math.max(1, opts.limit))))
  if (opts.recent) url.searchParams.set('freshness', BRAVE_FRESHNESS[opts.recent])
  if (opts.after || opts.before) url.searchParams.set('freshness', `${opts.after ?? '2000-01-01'}to${opts.before ?? new Date().toISOString().slice(0, 10)}`)
  if (opts.language) url.searchParams.set('search_lang', opts.language)
  if (opts.country) url.searchParams.set('country', opts.country)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
  const signal = opts.signal ? AbortSignal.any([controller.signal, opts.signal]) : controller.signal
  try {
    const res = await fetchImpl(url, {
      headers: { Accept: 'application/json', 'X-Subscription-Token': key },
      signal
    })
    if (!res.ok) {
      const code = res.status === 401 || res.status === 403 ? 'api_key_rejected' : res.status === 429 ? 'rate_limited' : 'http_error'
      const message =
        code === 'api_key_rejected' ? 'Brave 拒绝了这个 API key（无效或额度已用完）'
        : code === 'rate_limited' ? 'Brave 搜索请求过于频繁或额度用尽（429）'
        : `Brave 返回 HTTP ${res.status}`
      return { source: 'brave', rows: null, error: { code, message }, elapsedMs: elapsed() }
    }
    const body = (await res.json()) as { web?: { results?: Array<Record<string, unknown>> } }
    const results = body.web?.results ?? []
    const rows = results.map((r) => ({
      title: stripTags(r.title),
      url: r.url,
      snippet: stripTags(r.description),
      published: typeof r.page_age === 'string' ? r.page_age.slice(0, 10) : typeof r.age === 'string' ? r.age : undefined
    }))
    return { source: 'brave', rows, elapsedMs: elapsed() }
  } catch (e) {
    if (opts.signal?.aborted) {
      return { source: 'brave', rows: null, skipped: true, elapsedMs: elapsed() }
    }
    if (controller.signal.aborted) {
      return { source: 'brave', rows: null, timedOut: true, error: { code: 'timeout', message: `超过 ${opts.timeoutMs}ms 没有返回` }, elapsedMs: elapsed() }
    }
    return { source: 'brave', rows: null, error: { code: 'network_error', message: e instanceof Error ? e.message : String(e) }, elapsedMs: elapsed() }
  } finally {
    clearTimeout(timer)
  }
}
