import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { SEARCH_OPS_READ_CHANNEL, SEARCH_SITE_ICON_CHANNEL } from '../../shared/ipc'
import { createSiteIconLoader } from '../search/site-icon'
import type { WebSearchOpView, WebSearchPageView, WebSearchSourceView } from '../../shared/ipc'
import type { IpcRegistrar } from './registrar'

const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HTTP_URL = /^https?:\/\//i
const MAX_FILE_BYTES = 4 * 1024 * 1024
const MAX_SOURCES = 30
const MAX_SNIPPET = 300
const MAX_TITLE = 200
const MAX_SOURCE_NAME = 40

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase()
  } catch {
    return ''
  }
}

function searchKey(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    const kept = [...parsed.searchParams.entries()].filter(([key]) => !/^utm_/i.test(key))
    kept.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    parsed.search = ''
    for (const [key, value] of kept) parsed.searchParams.append(key, value)
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}${parsed.search}`
  } catch {
    return url
  }
}

export function clipText(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

export function httpUrl(value: unknown): string {
  if (typeof value !== 'string') return ''
  const raw = value.trim()
  return HTTP_URL.test(raw) ? raw : ''
}

export function cleanSearchSources(data: unknown): WebSearchSourceView[] {
  const root = asRecord(data)
  if (!root) return []
  const lists: unknown[][] = []
  if (Array.isArray(root.items)) lists.push(root.items)
  if (Array.isArray(root.queries)) {
    for (const query of root.queries) {
      const items = asRecord(query)?.items
      if (Array.isArray(items)) lists.push(items)
    }
  }
  const seen = new Set<string>()
  const sources: WebSearchSourceView[] = []
  for (const list of lists) {
    for (const entry of list) {
      const item = asRecord(entry)
      if (!item) continue
      const url = httpUrl(item.url)
      if (!url) continue
      const key = searchKey(url)
      if (seen.has(key)) continue
      seen.add(key)
      const domain = hostOf(url)
      const title = clipText(item.title, MAX_TITLE) || domain || url
      sources.push({
        title,
        url,
        domain,
        snippet: clipText(item.snippet ?? item.summary ?? item.description, MAX_SNIPPET),
        source: clipText(item.source, MAX_SOURCE_NAME),
        readState: 'discovered',
        published: clipText(item.published, 40),
        fetchedAt: clipText(root.fetchedAt, 40),
        cached: root.cached === true
      })
      if (sources.length >= MAX_SOURCES) return sources
    }
  }
  return sources
}

export function cleanFetchPage(data: unknown): WebSearchPageView | null {
  const root = asRecord(data)
  if (!root) return null
  const url = httpUrl(root.finalUrl) || httpUrl(root.url)
  if (!url) return null
  const domain = hostOf(url)
  return {
    title: clipText(root.title, MAX_TITLE) || domain || url,
    url,
    domain,
    excerpt: clipText(root.text ?? root.excerpt ?? root.markdown, MAX_SNIPPET),
    fetchedAt: clipText(root.fetchedAt, 40),
    cached: root.cached === true,
    truncated: root.truncated === true,
    sourceTruncated: root.sourceTruncated === true || root.action === 'find' || root.action === 'links'
  }
}

function looksLikeSearch(root: Record<string, unknown>): boolean {
  return Array.isArray(root.items) || Array.isArray(root.queries)
}

export function cleanSearchOp(data: unknown): WebSearchOpView {
  const root = asRecord(data)
  if (!root) return { ok: false, error: 'bad_result' }
  if (root.truncated === true && typeof root.head === 'string') return { ok: false, error: 'truncated' }
  if (looksLikeSearch(root)) return { ok: true, kind: 'search', sources: cleanSearchSources(root) }
  const page = cleanFetchPage(root)
  if (page) return { ok: true, kind: 'fetch', page }
  return { ok: false, error: 'unsupported_result' }
}

export function readSearchOpFile(opsDir: string, operationId: string): WebSearchOpView {
  const id = String(operationId ?? '').trim().toLowerCase()
  if (!OPERATION_ID.test(id)) return { ok: false, error: 'bad_operation_id' }
  const path = join(opsDir, `${id}.json`)
  let info: ReturnType<typeof statSync>
  try {
    info = statSync(path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    return { ok: false, error: code === 'ENOENT' ? 'not_found' : 'unavailable' }
  }
  if (!info.isFile()) return { ok: false, error: 'not_found' }
  if (info.size > MAX_FILE_BYTES) return { ok: false, error: 'too_large' }
  return cleanSearchOp(JSON.parse(readFileSync(path, 'utf8')))
}

export function registerSearchOpsIpc(ipc: IpcRegistrar, opts: { opsDir: string }): void {
  const siteIcon = createSiteIconLoader()
  ipc.handle(SEARCH_SITE_ICON_CHANNEL, (url: unknown) => typeof url === 'string' && url.length <= 8192 ? siteIcon(url) : null)
  ipc.handle(SEARCH_OPS_READ_CHANNEL, (operationId: unknown): WebSearchOpView => {
    try {
      return readSearchOpFile(opts.opsDir, typeof operationId === 'string' ? operationId : '')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      return { ok: false, error: code === 'ENOENT' ? 'not_found' : 'unavailable' }
    }
  })
}
