import { randomUUID } from 'node:crypto'
import { ReadPageError, type ReadPageResult } from './page-types'
import { markdownLinks } from './page-links'

export interface PageSnapshot extends ReadPageResult {
  pageRef: string
  fetchedAt: string
  via: string
  note?: string
}

const TTL_MS = 30 * 60_000
const MAX_STORED_CHARS = 8_000_000
const MAX_SNAPSHOTS = 32

export class PageStore {
  private readonly pages = new Map<string, { at: number; page: PageSnapshot }>()
  private chars = 0

  constructor(private readonly now: () => number = Date.now) {}

  put(page: ReadPageResult, via: string, note?: string): PageSnapshot {
    const snapshot: PageSnapshot = { ...page, links: page.links ?? markdownLinks(page.text, page.finalUrl), pageRef: `page-${randomUUID()}`, fetchedAt: page.fetchedAt ?? new Date(this.now()).toISOString(), via, ...(note ? { note } : {}) }
    this.pages.set(snapshot.pageRef, { at: this.now(), page: snapshot })
    this.chars += page.text.length
    for (const [key, entry] of this.pages) {
      if (this.pages.size <= MAX_SNAPSHOTS && this.chars <= MAX_STORED_CHARS && this.now() - entry.at < TTL_MS) break
      this.pages.delete(key)
      this.chars -= entry.page.text.length
    }
    return snapshot
  }

  get(ref: string): PageSnapshot {
    const entry = this.pages.get(ref)
    if (!entry || this.now() - entry.at >= TTL_MS) {
      if (entry) { this.pages.delete(ref); this.chars -= entry.page.text.length }
      throw new ReadPageError('snapshot_expired', '页面快照已过期或不属于当前会话，请用原网址重新读取')
    }
    this.pages.delete(ref)
    this.pages.set(ref, entry)
    return entry.page
  }
}

export function pageRange(page: PageSnapshot, offset = 0, maxChars = 12_000) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > page.text.length) throw new ReadPageError('bad_offset', `offset 应在 0–${page.text.length} 之间`)
  const limit = Math.min(40_000, Math.max(500, Math.round(maxChars)))
  if (!Number.isFinite(limit)) throw new ReadPageError('bad_limit', 'maxChars 必须是有限数值')
  const end = Math.min(page.text.length, offset + limit)
  const { text, links, ...meta } = page
  return {
    ...meta,
    text: text.slice(offset, end),
    offset,
    endOffset: end,
    startLine: text.slice(0, offset).split('\n').length,
    endLine: text.slice(0, end).split('\n').length,
    storedChars: text.length,
    truncated: end < text.length || page.truncated,
    sourceTruncated: page.truncated,
    ...(end < text.length ? { nextOffset: end } : {}),
    linkCount: links?.length ?? 0
  }
}

export function findInPage(page: PageSnapshot, query: string, offset = 0) {
  const term = query.trim()
  if (!term || term.length > 200) throw new ReadPageError('bad_find', '页内查询应为 1–200 字的文本')
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > page.text.length) throw new ReadPageError('bad_offset', '页内查询起点无效')
  const matcher = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')
  matcher.lastIndex = offset
  const matches: Array<{ offset: number; line: number; page?: number; text: string }> = []
  let nextOffset: number | undefined
  for (;;) {
    const found = matcher.exec(page.text)
    if (!found) break
    const at = found.index
    if (matches.length === 20) { nextOffset = at; break }
    const pdfPage = page.pages?.find((p) => p.offset <= at && p.endOffset > at)
    matches.push({ offset: at, line: page.text.slice(0, at).split('\n').length, ...(pdfPage ? { page: pdfPage.page } : {}), text: page.text.slice(Math.max(0, at - 180), at + term.length + 300) })
  }
  return { pageRef: page.pageRef, url: page.url, finalUrl: page.finalUrl, title: page.title, fetchedAt: page.fetchedAt, query: term, matches, sourceTruncated: page.truncated, ...(nextOffset !== undefined ? { nextOffset } : {}) }
}
