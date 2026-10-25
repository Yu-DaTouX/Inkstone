import type { SourceRun } from './aggregate'
import { callApi, parseJson, type ApiResult } from './api-call'
import { isoDay, recencySince, siteOperator, withOperators, type SourceRequest } from './modifiers'
import { normalizeReadUrl, READ_PAGE_MAX_CHARS_DEFAULT, READ_PAGE_MAX_CHARS_MAX, ReadPageError, type ReadPageResult } from './read-page'
import { resolveQuotaProviderSecret } from '../quota-credentials'

const SEARCH_ENDPOINT = 'https://api.deepseek.com/v1/tools/search'
const FETCH_ENDPOINT = 'https://api.deepseek.com/v1/tools/fetch'
const BALANCE_ENDPOINT = 'https://api.deepseek.com/user/balance'
const BALANCE_TTL_MS = 3 * 60_000
const BALANCE_TIMEOUT_MS = 3_000
const QUERY_MAX_CHARS = 128
const COUNT_MAX = 50

type KeyResolver = () => Promise<string | undefined>

export const resolveDeepseekSearchKey: KeyResolver = () => resolveQuotaProviderSecret('deepseek')

interface SearchBody {
  results?: Array<Record<string, unknown>>
}

interface FetchBody {
  title?: unknown
  content?: unknown
}

const KEY_MISSING = '没有可用的 DeepSeek key（在模型设置里登录或配置 DeepSeek）'

function failure(res: Extract<ApiResult, { ok: false }>, action: 'search' | 'fetch'): { code: string; message: string } {
  const detail = parseJson<{ error?: { message?: unknown } }>(res.body ?? '')?.error?.message
  const suffix = typeof detail === 'string' && detail.trim() ? `：${detail.trim().slice(0, 200)}` : ''
  switch (res.status) {
    case 402: return { code: 'insufficient_balance', message: `DeepSeek 账户余额不足（HTTP 402）${suffix}` }
    case 429: return { code: 'rate_limited', message: `超过 DeepSeek 账号的 ${action === 'search' ? 'Search' : 'Fetch'} QPS 限制（HTTP 429），稍后再试` }
    case 403: if (action === 'fetch') return { code: 'blocked', message: `DeepSeek 按安全策略拒绝读取这个网址（HTTP 403）${suffix}` }; break
    case 404: if (action === 'fetch') return { code: 'no_content', message: 'DeepSeek 没取到这个网页的可用内容（HTTP 404）' }; break
  }
  return { code: res.code, message: res.message + suffix }
}

const NO_BALANCE = 'DeepSeek 账户余额不足，已暂停调用（充值后约 3 分钟内自动恢复）'

let balance: { key: string; at: number; funded: Promise<boolean> } | null = null

function rememberBalance(key: string, funded: boolean): void {
  balance = { key, at: Date.now(), funded: Promise.resolve(funded) }
}

interface BalanceBody {
  is_available?: unknown
  balance_infos?: Array<{ total_balance?: unknown } | null>
}

async function queryBalance(key: string, fetchImpl: typeof fetch): Promise<boolean> {
  const res = await callApi('DeepSeek', BALANCE_ENDPOINT, { headers: { Accept: 'application/json', Authorization: `Bearer ${key}` } }, BALANCE_TIMEOUT_MS, fetchImpl)
  const body = res.ok ? parseJson<BalanceBody>(res.text) : null
  if (typeof body?.is_available === 'boolean') return body.is_available
  if (Array.isArray(body?.balance_infos)) return body.balance_infos.some((info) => Number(info?.total_balance) > 0)
  return true
}

export function deepseekHasBalance(key: string, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<boolean> {
  if (balance?.key === key && now - balance.at < BALANCE_TTL_MS) return balance.funded
  const funded = queryBalance(key, fetchImpl)
  balance = { key, at: now, funded }
  return funded
}

export async function runFundedDeepseekSearch(query: string, opts: SourceRequest): Promise<SourceRun> {
  const key = await resolveDeepseekSearchKey()
  if (key && !(await deepseekHasBalance(key))) {
    return { source: 'deepseek', rows: null, unavailable: true, error: { code: 'insufficient_balance', message: NO_BALANCE }, elapsedMs: 0 }
  }
  return runDeepseekSearch(query, opts)
}

export async function fundedDeepseekReadPage(rawUrl: string, opts: { maxChars?: number; timeoutMs?: number } = {}): Promise<ReadPageResult> {
  normalizeReadUrl(rawUrl)
  const key = await resolveDeepseekSearchKey()
  if (key && !(await deepseekHasBalance(key))) throw new ReadPageError('insufficient_balance', NO_BALANCE)
  return deepseekReadPage(rawUrl, opts)
}

const rerankOf = (row: Record<string, unknown>): number => (typeof row.rerank_score === 'number' && Number.isFinite(row.rerank_score) ? row.rerank_score : -1)

function withCallerAbort(fetchImpl: typeof fetch, signal?: AbortSignal): typeof fetch {
  if (!signal) return fetchImpl
  return (input, init) => fetchImpl(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal })
}

export function deepseekSearchBody(query: string, opts: SourceRequest, now = Date.now()): Record<string, unknown> {
  const operators = [siteOperator(opts.sites), opts.recent ? `after:${isoDay(recencySince(opts.recent, now))}` : '']
  const question = opts.question ? Array.from(opts.question.trim()).slice(0, QUERY_MAX_CHARS).join('') : ''
  return {
    query: withOperators(query, operators, QUERY_MAX_CHARS),
    count: Math.min(COUNT_MAX, Math.max(1, opts.limit)),
    ...(question ? { ori_question: question } : {}),
    ...(opts.withContent ? { need_content: true } : {})
  }
}

export async function runDeepseekSearch(
  query: string,
  opts: SourceRequest,
  fetchImpl: typeof fetch = fetch,
  resolveKey: KeyResolver = resolveDeepseekSearchKey
): Promise<SourceRun> {
  const started = Date.now()
  const elapsed = (): number => Date.now() - started
  const key = await resolveKey()
  if (!key) return { source: 'deepseek', rows: null, unavailable: true, error: { code: 'api_key_missing', message: KEY_MISSING }, elapsedMs: 0 }
  const res = await callApi(
    'DeepSeek',
    SEARCH_ENDPOINT,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(deepseekSearchBody(query, opts))
    },
    opts.timeoutMs,
    withCallerAbort(fetchImpl, opts.signal)
  )
  if (opts.signal?.aborted) return { source: 'deepseek', rows: null, skipped: true, elapsedMs: elapsed() }
  if (!res.ok && res.status === 402) rememberBalance(key, false)
  if (!res.ok) return { source: 'deepseek', rows: null, error: failure(res, 'search'), ...(res.timedOut ? { timedOut: true } : {}), elapsedMs: elapsed() }
  const body = parseJson<SearchBody>(res.text)
  if (!body || !Array.isArray(body.results)) {
    return { source: 'deepseek', rows: null, error: { code: 'bad_response', message: 'DeepSeek 返回的内容不是预期的 JSON' }, elapsedMs: elapsed() }
  }
  const rows = body.results.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object' && !Array.isArray(row))
    .sort((a, b) => rerankOf(b) - rerankOf(a))
    .map((r) => ({
      title: r.title,
      url: r.url,
      snippet: typeof r.snippet === 'string' && r.snippet.trim() ? r.snippet : r.summary,
      summary: r.summary,
      rerank_score: r.rerank_score,
      authority: r.authority,
      published: typeof r.date === 'string' ? r.date.slice(0, 10) : undefined,
      ...(opts.withContent && typeof r.content === 'string' && r.content.trim() ? { content: r.content } : {})
    }))
  return { source: 'deepseek', rows, elapsedMs: elapsed() }
}

export async function deepseekReadPage(
  rawUrl: string,
  opts: { maxChars?: number; timeoutMs?: number } = {},
  fetchImpl: typeof fetch = fetch,
  resolveKey: KeyResolver = resolveDeepseekSearchKey
): Promise<ReadPageResult> {
  const url = normalizeReadUrl(rawUrl)
  const key = await resolveKey()
  if (!key) throw new ReadPageError('api_key_missing', KEY_MISSING)
  const maxChars = Math.min(READ_PAGE_MAX_CHARS_MAX, Math.max(500, Math.round(opts.maxChars ?? READ_PAGE_MAX_CHARS_DEFAULT)))
  const timeoutMs = Math.min(60_000, Math.max(3_000, Math.round(opts.timeoutMs ?? 30_000)))
  const res = await callApi(
    'DeepSeek',
    FETCH_ENDPOINT,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ url })
    },
    timeoutMs,
    fetchImpl
  )
  if (!res.ok) {
    if (res.status === 402) rememberBalance(key, false)
    const { code, message } = failure(res, 'fetch')
    throw new ReadPageError(code, message)
  }
  const body = parseJson<FetchBody>(res.text)
  if (!body || typeof body.content !== 'string' || !body.content.trim()) throw new ReadPageError('bad_response', 'DeepSeek 没有返回正文')
  const text = body.content.trim()
  return {
    url,
    finalUrl: url,
    title: typeof body.title === 'string' ? body.title.trim() : '',
    text: text.length > maxChars ? text.slice(0, maxChars) : text,
    truncated: text.length > maxChars,
    totalChars: text.length
  }
}
