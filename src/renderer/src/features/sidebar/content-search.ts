import type { SessionSearchHit, SessionSummary } from '../../../../shared/ipc'
import { queryTokens } from '../../../../shared/session-search-text'

export const CONTENT_SEARCH_MIN_CHARS = 2
export const CONTENT_SEARCH_LIMIT = 20

export interface ContentMatch {
  path: string
  id: string | null
  title: string
  snippet: string
  updatedAt: number
  archived: boolean
}

export interface SnippetPart {
  text: string
  hit: boolean
}

function samePath(a: string, b: string): boolean {
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()
}

export function shouldSearchContent(query: string): boolean {
  return query.trim().length >= CONTENT_SEARCH_MIN_CHARS
}

export function buildContentMatches(options: {
  hits: readonly SessionSearchHit[]
  sessions: readonly SessionSummary[]
  shownPaths: readonly string[]
  titleOf: (item: SessionSummary) => string
  fallbackTitle: (updatedAt: number) => string
  limit?: number
}): ContentMatch[] {
  const out: ContentMatch[] = []
  const limit = options.limit ?? CONTENT_SEARCH_LIMIT
  for (const hit of options.hits) {
    if (out.length >= limit) break
    if (options.shownPaths.some((path) => samePath(path, hit.path))) continue
    if (out.some((match) => samePath(match.path, hit.path))) continue
    const session = options.sessions.find((item) => samePath(item.path, hit.path))
    out.push({
      path: session?.path ?? hit.path,
      id: session?.id ?? null,
      title: (session ? options.titleOf(session) : '') || options.fallbackTitle(hit.updatedAt),
      snippet: hit.snippet,
      updatedAt: hit.updatedAt,
      archived: !!session?.archivedAt
    })
  }
  return out
}

export function focusSnippet(snippet: string, query: string, lead = 12): string {
  const lower = snippet.toLowerCase()
  let first = -1
  for (const token of queryTokens(query)) {
    const at = lower.indexOf(token.toLowerCase())
    if (at >= 0 && (first < 0 || at < first)) first = at
  }
  if (first <= lead + 1) return snippet
  return `…${snippet.slice(first - lead).trimStart()}`
}

export function splitSnippet(snippet: string, query: string): SnippetPart[] {
  const tokens = queryTokens(query).map((token) => token.toLowerCase())
  if (!tokens.length || !snippet) return snippet ? [{ text: snippet, hit: false }] : []
  const lower = snippet.toLowerCase()
  if (lower.length !== snippet.length) return [{ text: snippet, hit: false }]
  const marks = new Array<boolean>(snippet.length).fill(false)
  for (const token of tokens) {
    let from = 0
    while (from <= lower.length - token.length) {
      const at = lower.indexOf(token, from)
      if (at < 0) break
      for (let i = at; i < at + token.length; i += 1) marks[i] = true
      from = at + token.length
    }
  }
  const parts: SnippetPart[] = []
  for (let i = 0; i < snippet.length; i += 1) {
    const last = parts[parts.length - 1]
    if (last && last.hit === marks[i]) last.text += snippet[i]
    else parts.push({ text: snippet[i], hit: marks[i] })
  }
  return parts
}
