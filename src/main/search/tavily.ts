/**
 * Tavily 搜索来源。与 Brave 并列：产出同样的 `SourceRun`，由 `aggregate.ts` 统一归一化，
 * 失败按来源如实上报。需要用户自己的 API key（设置 → 能力 → 增强搜索）。
 */
import type { SourceRun } from './aggregate'
import { callApi, parseJson } from './api-call'
import { resolveSearchKey } from './config'

const ENDPOINT = 'https://api.tavily.com/search'

interface TavilyBody {
  results?: Array<Record<string, unknown>>
}

export async function runTavilySearch(
  query: string,
  opts: { limit: number; timeoutMs: number },
  fetchImpl: typeof fetch = fetch
): Promise<SourceRun> {
  const started = Date.now()
  const elapsed = (): number => Date.now() - started
  const key = await resolveSearchKey('tavily')
  if (!key) {
    return {
      source: 'tavily',
      rows: null,
      unavailable: true,
      error: { code: 'api_key_missing', message: '未配置 Tavily API key（设置 → 能力 → 增强搜索）' },
      elapsedMs: 0
    }
  }
  const res = await callApi(
    'Tavily',
    ENDPOINT,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${key}` },
      /* basic 每次 1 credit；advanced 要 2 credit，默认不替用户多花额度 */
      body: JSON.stringify({ query, max_results: Math.min(20, Math.max(1, opts.limit)), search_depth: 'basic', topic: 'general' })
    },
    opts.timeoutMs,
    fetchImpl
  )
  if (!res.ok) {
    return { source: 'tavily', rows: null, error: { code: res.code, message: res.message }, ...(res.timedOut ? { timedOut: true } : {}), elapsedMs: elapsed() }
  }
  const body = parseJson<TavilyBody>(res.text)
  if (!body || !Array.isArray(body.results)) {
    return { source: 'tavily', rows: null, error: { code: 'bad_response', message: 'Tavily 返回的内容不是预期的 JSON' }, elapsedMs: elapsed() }
  }
  const rows = body.results.map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.content,
    published: typeof r.published_date === 'string' ? r.published_date.slice(0, 10) : undefined
  }))
  return { source: 'tavily', rows, elapsedMs: elapsed() }
}
