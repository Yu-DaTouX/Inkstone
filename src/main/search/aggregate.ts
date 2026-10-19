import {
  SEARCH_CONTENT_MAX,
  SEARCH_SNIPPET_MAX,
  type PerSourceStatus,
  type SearchItem,
  type SearchSourceId,
  type SearchRecency,
  type SourceStatusKind
} from '../../shared/search'
import { RECENCY_SOURCES, siteMatches } from './modifiers'

export interface SourceRun {
  source: SearchSourceId
  rows: unknown[] | null
  error?: { code?: string; message?: string }
  timedOut?: boolean
  unavailable?: boolean
  skipped?: boolean
  elapsedMs: number
}

export interface AggregateOptions {
  limitPerSource: number
  limitTotal: number
  sites?: readonly string[]
  recent?: SearchRecency
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
  const content = cleanContent(r.content)
  if (content) item.content = content
  const meta: Record<string, string | number> = {}
  if (typeof r.authors === 'string' && r.authors) meta.authors = cleanText(r.authors, 160) ?? r.authors
  if (typeof r.primary_category === 'string' && r.primary_category) meta.category = r.primary_category
  if (Object.keys(meta).length) item.meta = meta
  return item
}

function cleanContent(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined
  const t = input.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  if (!t) return undefined
  return t.length > SEARCH_CONTENT_MAX ? t.slice(0, SEARCH_CONTENT_MAX - 1) + '…' : t
}

function statusOf(run: SourceRun): { status: SourceStatusKind; code?: string; message?: string } {
  if (run.skipped) return { status: 'skipped', code: 'skipped', message: run.error?.message ?? '已有足够结果，提前停止' }
  if (run.unavailable) return { status: 'unavailable', code: run.error?.code ?? 'backend_unavailable', message: run.error?.message }
  if (run.timedOut) return { status: 'timeout', code: run.error?.code ?? 'timeout', message: run.error?.message }
  if (run.error) return { status: 'error', code: run.error.code ?? 'error', message: run.error.message }
  if (!run.rows || run.rows.length === 0) return { status: 'empty' }
  return { status: 'ok' }
}

const FUSION_K = 6

interface Ranked {
  item: SearchItem
  owner: number
  score: number
  bestRank: number
}

export function aggregate(runs: SourceRun[], opts: AggregateOptions): AggregateResult {
  const sources: PerSourceStatus[] = []
  const merged = new Map<string, Ranked>()
  let truncated = false

  const sites = opts.sites?.length ? opts.sites : undefined
  runs.forEach((run, owner) => {
    const statusInfo = statusOf(run)
    const { code, message } = statusInfo
    let { status } = statusInfo
    let badRows = 0
    let offSite = 0

    if (status === 'ok') {
      const rows = run.rows ?? []
      const ownSeen = new Set<string>()
      let rank = 0
      for (const row of sites ? rows : rows.slice(0, opts.limitPerSource)) {
        const item = normalizeRow(run.source, row)
        if (!item) {
          badRows++
          continue
        }
        if (sites && !siteMatches(item.url, sites)) {
          offSite++
          continue
        }
        if (rank >= opts.limitPerSource) {
          truncated = true
          break
        }
        const key = normalizeUrlForDedupe(item.url)
        if (ownSeen.has(key)) continue
        ownSeen.add(key)
        const gain = 1 / (FUSION_K + rank)
        const hit = merged.get(key)
        if (hit) {
          hit.score += gain
          hit.bestRank = Math.min(hit.bestRank, rank)
          if (!hit.item.snippet && item.snippet) hit.item.snippet = item.snippet
          if (!hit.item.published && item.published) hit.item.published = item.published
          if (!hit.item.content && item.content) hit.item.content = item.content
        } else {
          merged.set(key, { item, owner, score: gain, bestRank: rank })
        }
        rank++
      }
      if (!sites && rows.length > opts.limitPerSource) truncated = true
      if (rank === 0 && offSite > 0) status = 'empty'
    }

    const notes: string[] = []
    if (message) notes.push(message)
    if (badRows > 0) notes.push(`${badRows} 条结果结构不认识，已跳过`)
    if (offSite > 0) notes.push(`${offSite} 条不在指定站点，已去掉`)
    if (opts.recent && !RECENCY_SOURCES.has(run.source) && (status === 'ok' || status === 'empty')) notes.push('这个来源不支持按时间过滤，结果没有限定时间')
    const entry: PerSourceStatus = {
      source: run.source,
      status,
      count: 0,
      elapsedMs: Number.isFinite(run.elapsedMs) ? Math.max(0, Math.round(run.elapsedMs)) : 0
    }
    if (code) entry.code = code
    if (notes.length) entry.message = notes.join('；')
    sources.push(entry)
  })

  const ranked = [...merged.values()].sort((a, b) => b.score - a.score || a.bestRank - b.bestRank || a.owner - b.owner)
  if (ranked.length > opts.limitTotal) truncated = true
  ranked.forEach((r, index) => {
    const entry = sources[r.owner]
    if (index < opts.limitTotal) entry.count++
    else entry.droppedByLimit = (entry.droppedByLimit ?? 0) + 1
  })

  return { items: ranked.slice(0, opts.limitTotal).map((r) => r.item), sources, truncated }
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
    if (s.status === 'skipped') return `${s.source} 已提前停止`
    if (s.status === 'unavailable') return `${s.source} 不可用`
    return `${s.source} 出错${s.code ? `（${s.code}）` : ''}`
  }
  return sources.map(label).join(' · ')
}
