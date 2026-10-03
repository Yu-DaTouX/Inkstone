/**
 * Firecrawl 读网页：`yan search fetch` 在本地隐藏窗口读不出来（超时、正文几乎为空）时的兜底，
 * 也可以用 `--via firecrawl` 指定。返回与 `readPage` 同一形状，模型不用区分是谁读的。
 *
 * 边界：网址会发给 Firecrawl 云端，所以仍先过 `normalizeReadUrl`——本机和内网地址
 * 一律不发出去；key 由用户自己配置，没配就不会走到这里。
 */
import { callApi, parseJson } from './api-call'
import { resolveSearchKey } from './config'
import { normalizeReadUrl, READ_PAGE_MAX_CHARS_DEFAULT, READ_PAGE_MAX_CHARS_MAX, ReadPageError, type ReadPageResult } from './read-page'

const ENDPOINT = 'https://api.firecrawl.dev/v2/scrape'

interface ScrapeBody {
  success?: boolean
  error?: string
  data?: { markdown?: string; metadata?: Record<string, unknown> }
}

const asText = (value: unknown): string => (Array.isArray(value) ? String(value[0] ?? '') : typeof value === 'string' ? value : '')

export async function firecrawlReadPage(
  rawUrl: string,
  opts: { maxChars?: number; timeoutMs?: number } = {},
  fetchImpl: typeof fetch = fetch
): Promise<ReadPageResult> {
  const url = normalizeReadUrl(rawUrl)
  const key = await resolveSearchKey('firecrawl')
  if (!key) throw new ReadPageError('api_key_missing', '未配置 Firecrawl API key（设置 → 能力 → 增强搜索）')
  const maxChars = Math.min(READ_PAGE_MAX_CHARS_MAX, Math.max(500, Math.round(opts.maxChars ?? READ_PAGE_MAX_CHARS_DEFAULT)))
  const timeoutMs = Math.min(60_000, Math.max(3_000, Math.round(opts.timeoutMs ?? 30_000)))
  const res = await callApi(
    'Firecrawl',
    ENDPOINT,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      /* 服务端超时比本地等待短一点，免得我们先放弃、它还在计费 */
      body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true, timeout: Math.max(1_000, timeoutMs - 2_000) })
    },
    timeoutMs,
    fetchImpl
  )
  if (!res.ok) throw new ReadPageError(res.code, res.message)
  const body = parseJson<ScrapeBody>(res.text)
  const markdown = body?.data?.markdown
  if (!body || body.success === false || typeof markdown !== 'string') {
    throw new ReadPageError('bad_response', body?.error ? `Firecrawl：${body.error}` : 'Firecrawl 没有返回正文')
  }
  const meta = body.data?.metadata ?? {}
  const text = markdown.trim()
  return {
    url,
    finalUrl: asText(meta.url) || asText(meta.sourceURL) || url,
    title: asText(meta.title).trim(),
    text: text.length > maxChars ? text.slice(0, maxChars) : text,
    truncated: text.length > maxChars,
    totalChars: text.length
  }
}
