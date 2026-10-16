import {
  SEARCH_SNIPPET_MAX,
  type PerSourceStatus,
  type SearchItem,
  type SearchSourceId,
  type SourceStatusKind
} from '../../shared/search'

export interface SourceRun {
  source: SearchSourceId
  rows: unknown[] | null
  error?: { code?: string; message?: string }
  timedOut?: boolean
  unavailable?: boolean
  elapsedMs: number
}

export interface AggregateOptions {
  limitPerSource: number
  limitTotal: number
}

export interface AggregateResult {
  items: SearchItem[]
  sources: PerSourceStatus[]
  truncated: boolean
}

const ENTITIES: Record<string, string> = {
  '&quot;': '"',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&apos;': "'",
  '&nbsp;': ' '
}

export function decodeEntities(input: string): string {
  return input
    .replace(/&#(\d+);/g, (_m, n: string) => {
      const code = Number(n)
      return code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : ''
    })
    .replace(/&(?:quot|amp|lt|gt|apos|nbsp);/g, (m) => ENTITIES[m] ?? m)
}

export function cleanText(input: unknown, max = SEARCH_SNIPPET_MAX): string | undefined {
  if (typeof input !== 'string') return undefined
  const t = decodeEntities(input).replace(/\s+/g, ' ').trim()
  if (!t) return undefined
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

export function normalizeUrlForDedupe(raw: string): string {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return raw.trim()
  }
  u.hash = ''
  for (const key of [...u.searchParams.keys()]) {
    if (/^utm_/i.test(key) || /^(fbclid|gclid|ref|ref_src|source)$/i.test(key)) u.searchParams.delete(key)
  }
  u.host = u.host.toLowerCase()
  const qs = u.searchParams.toString()
  const path = u.pathname.replace(/\/+$/, '') || '/'
  return `${u.protocol}//${u.host}${path}${qs ? '?' + qs : ''}`
}

function hackerNewsUrl(id: unknown): string | null {
  const n = typeof id === 'number' ? id : typeof id === 'string' ? Number(id) : NaN
  return Number.isFinite(n) && n > 0 ? `https://news.ycombinator.com/item?id=${n}` : null
}

export function normalizeRow(source: SearchSourceId, row: unknown): SearchItem | null {
  if (!row || typeof row !== 'object') return null
  const r = row as Record<string, unknown>
  const title = cleanText(r.title, 200)
  if (!title) return null

  if (source === 'hackernews') {
    const url = hackerNewsUrl(r.id)
    if (!url) return null
    const meta: Record<string, string | number> = {}
    if (typeof r.score === 'number') meta.score = r.score
    if (typeof r.comments === 'number') meta.comments = r.comments
    if (typeof r.author === 'string' && r.author) meta.author = r.author
    const item: SearchItem = { title, url, source }
    if (Object.keys(meta).length) item.meta = meta
    return item
  }

  if (typeof r.url !== 'string' || r.url.length > 500) return null
  const url = cleanText(r.url, 500)
  if (!url) return null
  const item: SearchItem = { title, url, source }
  const snippet = cleanText(r.snippet)
  if (snippet) item.snippet = snippet
  const published = cleanText(r.published, 40)
  if (published) item.published = published
  const meta: Record<string, string | number> = {}
  if (typeof r.authors === 'string' && r.authors) meta.authors = cleanText(r.authors, 160) ?? r.authors
  if (typeof r.primary_category === 'string' && r.primary_category) meta.category = r.primary_category
  if (Object.keys(meta).length) item.meta = meta
  return item
}

function statusOf(run: SourceRun): { status: SourceStatusKind; code?: string; message?: string } {
  if (run.unavailable) return { status: 'unavailable', code: run.error?.code ?? 'backend_unavailable', message: run.error?.message }
  if (run.timedOut) return { status: 'timeout', code: run.error?.code ?? 'timeout', message: run.error?.message }
  if (run.error) return { status: 'error', code: run.error.code ?? 'error', message: run.error.message }
  if (!run.rows || run.rows.length === 0) return { status: 'empty' }
  return { status: 'ok' }
}

export function aggregate(runs: SourceRun[], opts: AggregateOptions): AggregateResult {
  const items: SearchItem[] = []
  const sources: PerSourceStatus[] = []
  const seen = new Set<string>()
  let truncated = false

  for (const run of runs) {
    const { status, code, message } = statusOf(run)
    let kept = 0
    let badRows = 0
    let droppedByLimit = 0

    if (status === 'ok') {
      const rows = run.rows ?? []
      if (rows.length > opts.limitPerSource) truncated = true
      const candidates = rows.slice(0, opts.limitPerSource)
      for (let i = 0; i < candidates.length; i++) {
        const item = normalizeRow(run.source, candidates[i])
        if (!item) {
          badRows++
          continue
        }
        const key = normalizeUrlForDedupe(item.url)
        if (seen.has(key)) continue
        if (items.length >= opts.limitTotal) {
          droppedByLimit = candidates.length - i
          truncated = true
          break
        }
        seen.add(key)
        items.push(item)
        kept++
      }
    }

    const entry: PerSourceStatus = {
      source: run.source,
      status,
      count: kept,
      elapsedMs: Number.isFinite(run.elapsedMs) ? Math.max(0, Math.round(run.elapsedMs)) : 0
    }
    if (code) entry.code = code
    if (message) entry.message = message
    if (droppedByLimit > 0) entry.droppedByLimit = droppedByLimit
    if (badRows > 0) entry.message = (entry.message ? entry.message + '；' : '') + `${badRows} 条结果结构不认识，已跳过`
    sources.push(entry)
  }

  return { items, sources, truncated }
}

export function summarizeSources(sources: PerSourceStatus[]): string {
  const label = (s: PerSourceStatus): string => {
    if (s.status === 'ok') {
      return s.droppedByLimit
        ? `${s.source} ${s.count} 条（另有 ${s.droppedByLimit} 条被总数上限截断）`
        : `${s.source} ${s.count} 条`
    }
    if (s.status === 'empty') return `${s.source} 无结果`
    if (s.status === 'timeout') return `${s.source} 超时`
    if (s.status === 'unavailable') return `${s.source} 不可用`
    return `${s.source} 出错${s.code ? `（${s.code}）` : ''}`
  }
  return sources.map(label).join(' · ')
}
