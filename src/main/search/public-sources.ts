import type { SearchSourceId } from '../../shared/search'
import { decodeEntities, type SourceRun } from './aggregate'
import { detectLocale, type SourceRequest } from './modifiers'

const USER_AGENT = 'Inkstone/1.0 (desktop app search)'

async function fetchSource(
  source: SearchSourceId,
  url: URL,
  opts: SourceRequest,
  read: (res: Response) => Promise<unknown[]>,
  fetchImpl: typeof fetch
): Promise<SourceRun> {
  const started = Date.now()
  const elapsed = (): number => Date.now() - started
  if (opts.signal?.aborted) return { source, rows: null, skipped: true, elapsedMs: 0 }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
  const signal = opts.signal ? AbortSignal.any([controller.signal, opts.signal]) : controller.signal
  try {
    const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT }, signal })
    if (!res.ok) {
      const code = res.status === 429 ? 'rate_limited' : 'http_error'
      return { source, rows: null, error: { code, message: `${url.hostname} 返回 HTTP ${res.status}` }, elapsedMs: elapsed() }
    }
    return { source, rows: await read(res), elapsedMs: elapsed() }
  } catch (e) {
    if (opts.signal?.aborted) return { source, rows: null, skipped: true, elapsedMs: elapsed() }
    if (controller.signal.aborted) {
      return { source, rows: null, timedOut: true, error: { code: 'timeout', message: `超过 ${opts.timeoutMs}ms 没有返回` }, elapsedMs: elapsed() }
    }
    return { source, rows: null, error: { code: 'network_error', message: e instanceof Error ? e.message : String(e) }, elapsedMs: elapsed() }
  } finally {
    clearTimeout(timer)
  }
}

const stripTags = (input: unknown): string => (typeof input === 'string' ? input.replace(/<[^>]*>/g, '') : '')

export function runWikipediaSearch(query: string, opts: SourceRequest, fetchImpl: typeof fetch = fetch): Promise<SourceRun> {
  const lang = detectLocale(query) === 'zh' ? 'zh' : 'en'
  const url = new URL(`https://${lang}.wikipedia.org/w/api.php`)
  url.searchParams.set('action', 'query')
  url.searchParams.set('list', 'search')
  url.searchParams.set('srsearch', query)
  url.searchParams.set('srlimit', String(Math.min(20, Math.max(1, opts.limit))))
  url.searchParams.set('format', 'json')
  url.searchParams.set('utf8', '1')
  return fetchSource('wikipedia', url, opts, async (res) => {
    const body = (await res.json()) as { query?: { search?: Array<Record<string, unknown>> } }
    return (body.query?.search ?? []).map((r) => ({
      title: r.title,
      url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(String(r.title ?? '').replace(/ /g, '_'))}`,
      snippet: stripTags(r.snippet),
      published: typeof r.timestamp === 'string' ? r.timestamp.slice(0, 10) : undefined
    }))
  }, fetchImpl)
}

function xmlField(entry: string, tag: string): string {
  const match = entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))
  return match ? decodeEntities(match[1]).trim() : ''
}

export function parseArxivFeed(xml: string): Record<string, unknown>[] {
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, entry]) => ({
    title: xmlField(entry, 'title'),
    url: xmlField(entry, 'id').replace(/^http:\/\//, 'https://'),
    snippet: xmlField(entry, 'summary'),
    published: xmlField(entry, 'published').slice(0, 10),
    authors: [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) => decodeEntities(m[1]).trim()).join(', '),
    primary_category: entry.match(/<arxiv:primary_category[^>]*term="([^"]+)"/)?.[1] ?? ''
  }))
}

export function runArxivSearch(query: string, opts: SourceRequest, fetchImpl: typeof fetch = fetch): Promise<SourceRun> {
  const url = new URL('https://export.arxiv.org/api/query')
  url.searchParams.set('search_query', `all:${query}`)
  url.searchParams.set('start', '0')
  url.searchParams.set('max_results', String(Math.min(20, Math.max(1, opts.limit))))
  return fetchSource('arxiv', url, opts, async (res) => parseArxivFeed(await res.text()), fetchImpl)
}

export function runHackerNewsSearch(query: string, opts: SourceRequest, fetchImpl: typeof fetch = fetch): Promise<SourceRun> {
  const url = new URL('https://hn.algolia.com/api/v1/search')
  url.searchParams.set('query', query)
  url.searchParams.set('tags', 'story')
  url.searchParams.set('hitsPerPage', String(Math.min(20, Math.max(1, opts.limit))))
  return fetchSource('hackernews', url, opts, async (res) => {
    const body = (await res.json()) as { hits?: Array<Record<string, unknown>> }
    return (body.hits ?? []).map((hit) => ({
      id: Number(hit.objectID),
      title: hit.title,
      score: hit.points,
      comments: hit.num_comments,
      author: hit.author
    }))
  }, fetchImpl)
}
