/**
 * Brave Search API 来源。与 OpenCLI 来源并列：产出同样的 `SourceRun`，
 * 由 `aggregate.ts` 统一归一化，失败按来源如实上报。
 */
import type { SourceRun } from './aggregate'
import { resolveBraveKey } from './config'

const ENDPOINT = 'https://api.search.brave.com/res/v1/web/search'

/** Brave 的 description 带 <strong> 等高亮标签，去掉后交给统一的文本清洗 */
function stripTags(input: unknown): string {
  return typeof input === 'string' ? input.replace(/<[^>]*>/g, '') : ''
}

export async function runBraveSearch(
  query: string,
  opts: { limit: number; timeoutMs: number },
  fetchImpl: typeof fetch = fetch
): Promise<SourceRun> {
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
  url.searchParams.set('q', query)
  url.searchParams.set('count', String(Math.min(20, Math.max(1, opts.limit))))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
  try {
    const res = await fetchImpl(url, {
      headers: { Accept: 'application/json', 'X-Subscription-Token': key },
      signal: controller.signal
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
    if (controller.signal.aborted) {
      return { source: 'brave', rows: null, timedOut: true, error: { code: 'timeout', message: `超过 ${opts.timeoutMs}ms 没有返回` }, elapsedMs: elapsed() }
    }
    return { source: 'brave', rows: null, error: { code: 'network_error', message: e instanceof Error ? e.message : String(e) }, elapsedMs: elapsed() }
  } finally {
    clearTimeout(timer)
  }
}
