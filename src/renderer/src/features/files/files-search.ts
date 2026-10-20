import type { FileContentHit, FileContentSearchResult } from '../../../../shared/ipc'
import type { FileNameSearchResult } from '../../../../shared/file-name-search'

export const CONTENT_QUERY_PREFIX = '?'
const CONTENT_PREFIXES = ['?', '？']

export const CONTENT_SHOWN_LIMIT = 200
export const CONTENT_PER_FILE = 5
export const NAME_QUERY_MAX = 64
export const CONTENT_QUERY_MAX = 256
const SNIPPET_LEAD = 26
const SNIPPET_MIN_LEAD = 10

export type FilesQueryMode = 'name' | 'content'

export interface FilesQuery {
  mode: FilesQueryMode
  query: string
}

export interface ContentOptions {
  matchCase: boolean
  wholeWord: boolean
  regexp: boolean
}

export const DEFAULT_CONTENT_OPTIONS: ContentOptions = Object.freeze({ matchCase: false, wholeWord: false, regexp: false })

export function isContentQuery(raw: string): boolean {
  const trimmed = raw.trimStart()
  return CONTENT_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
}

export function parseFilesQuery(raw: string): FilesQuery {
  const trimmed = raw.trim()
  if (isContentQuery(trimmed)) return { mode: 'content', query: trimmed.slice(1).trim() }
  return { mode: 'name', query: trimmed }
}

export function contentQueryFrom(raw: string): string {
  const parsed = parseFilesQuery(raw)
  return `${CONTENT_QUERY_PREFIX}${parsed.query}`
}

export interface HighlightPart {
  text: string
  hit: boolean
}

export interface FilesSearchRow {
  key: string
  kind: 'entry' | 'line'
  path: string
  name: string
  dir: boolean
  parent: string
  nameParts: HighlightPart[]
  line?: number
  column?: number
  text?: string
  snippet?: HighlightPart[]
  lead?: string
  hit?: HighlightPart[]
  tail?: HighlightPart[]
  ellipsis?: boolean
  more?: boolean
}

export function splitTreePath(path: string): { parent: string; name: string } {
  const clean = path.replace(/\\/g, '/').replace(/\/+$/, '')
  const at = clean.lastIndexOf('/')
  return at < 0 ? { parent: '', name: clean } : { parent: clean.slice(0, at), name: clean.slice(at + 1) }
}

export function highlightParts(text: string, positions: readonly number[]): HighlightPart[] {
  if (!text) return []
  const hits = new Set(positions.filter((index) => index >= 0 && index < text.length))
  const parts: HighlightPart[] = []
  for (let index = 0; index < text.length; index += 1) {
    const hit = hits.has(index)
    const last = parts[parts.length - 1]
    if (last && last.hit === hit) last.text += text[index]
    else parts.push({ text: text[index], hit })
  }
  return parts
}

export function rangeParts(text: string, ranges: ReadonlyArray<readonly [number, number]>): HighlightPart[] {
  const positions: number[] = []
  for (const [start, end] of ranges) for (let index = start; index < end; index += 1) positions.push(index)
  return highlightParts(text, positions)
}

export function namePositions(path: string, positions: readonly number[]): number[] {
  const clean = path.replace(/\\/g, '/').replace(/\/+$/, '')
  const offset = clean.lastIndexOf('/') + 1
  return positions.filter((index) => index >= offset).map((index) => index - offset)
}

export function nameSearchRows(result: FileNameSearchResult): FilesSearchRow[] {
  return result.matches.map((match) => {
    const { parent, name } = splitTreePath(match.path)
    return {
      key: `n:${match.path}`,
      kind: 'entry',
      path: match.path,
      name: name || match.name,
      dir: match.directory,
      parent,
      nameParts: highlightParts(name || match.name, namePositions(match.path, match.positions))
    }
  })
}

type Range = [number, number]

export function collapseSnippetWhitespace(text: string, ranges: readonly Range[]): { text: string; ranges: Range[] } {
  const map: number[] = []
  let out = ''
  let inSpace = false
  for (let index = 0; index < text.length; index += 1) {
    map.push(out.length)
    const space = /\s/.test(text[index])
    if (!space) out += text[index]
    else if (!inSpace) out += ' '
    inSpace = space
  }
  map.push(out.length)
  const lead = out.length - out.trimStart().length
  const body = out.trim()
  const mapped = ranges
    .map(([start, end]): Range => [Math.max(0, (map[start] ?? out.length) - lead), Math.min(body.length, (map[end] ?? out.length) - lead)])
    .filter(([start, end]) => end > start)
  return { text: body, ranges: mapped }
}

function isWordCode(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95
}

function wordBoundary(text: string, index: number): boolean {
  return isWordCode(text.charCodeAt(index - 1)) !== isWordCode(text.charCodeAt(index))
}

export interface ContentSnippet {
  ellipsis: boolean
  text: string
  parts: HighlightPart[]
  lead: string
  hit: HighlightPart[]
  tail: HighlightPart[]
}

function snippetLayout(ellipsis: boolean, text: string, ranges: readonly Range[]): ContentSnippet {
  const parts = rangeParts(text, ranges)
  const first = ranges[0]
  if (!first) return { ellipsis, text, parts, lead: ellipsis ? '…' : '', hit: [], tail: parts }
  let start = first[0]
  while (start > 0 && /\s/.test(text[start - 1])) start -= 1
  const hitText = text.slice(start, first[1])
  const tailText = text.slice(first[1])
  return {
    ellipsis,
    text,
    parts,
    lead: `${ellipsis ? '…' : ''}${text.slice(0, start)}`,
    hit: rangeParts(hitText, [[first[0] - start, first[1] - start]]),
    tail: rangeParts(
      tailText,
      ranges.slice(1).map(([from, to]): Range => [from - first[1], to - first[1]])
    )
  }
}

export function contentSnippet(raw: string, rawRanges: readonly Range[] = []): ContentSnippet {
  const { text, ranges } = collapseSnippetWhitespace(raw, rawRanges)
  const first = ranges[0]
  if (!first || first[0] <= SNIPPET_LEAD) return snippetLayout(false, text, ranges)
  const target = first[0] - SNIPPET_LEAD
  let before: number | undefined
  for (let index = target; index > target - SNIPPET_LEAD && index > 0; index -= 1) {
    if (wordBoundary(text, index)) {
      before = index
      break
    }
  }
  let after: number | undefined
  for (let index = target + 1; index <= first[0] - SNIPPET_MIN_LEAD; index += 1) {
    if (wordBoundary(text, index)) {
      after = index
      break
    }
  }
  let start = after !== undefined && (before === undefined || after - target <= target - before) ? after : before ?? target
  while (start < first[0] && /\s/.test(text[start])) start += 1
  const code = text.charCodeAt(start)
  if (code >= 0xdc00 && code <= 0xdfff) start += 1
  const sliced = text.slice(start)
  const shifted = ranges.map(([from, to]): Range => [from - start, to - start]).filter(([from]) => from >= 0)
  return snippetLayout(true, sliced, shifted)
}

export interface ContentGroups {
  rows: FilesSearchRow[]
  shown: number
  truncated: boolean
}

export function groupContentHits(
  hits: readonly FileContentHit[],
  shownLimit = CONTENT_SHOWN_LIMIT,
  perFile = CONTENT_PER_FILE
): ContentGroups {
  const groups = new Map<string, { hits: FileContentHit[]; more: boolean }>()
  let shown = 0
  let truncated = false
  for (const hit of hits) {
    const group = groups.get(hit.path)
    if (group && group.hits.length >= perFile) {
      group.more = true
    } else if (shown >= shownLimit) {
      truncated = true
      if (group) group.more = true
    } else if (group) {
      group.hits.push(hit)
      shown += 1
    } else {
      groups.set(hit.path, { hits: [hit], more: false })
      shown += 1
    }
  }
  const rows: FilesSearchRow[] = []
  for (const [path, group] of groups) {
    const { parent, name } = splitTreePath(path)
    const fileName = name || group.hits[0].name
    rows.push({
      key: `f:${path}`,
      kind: 'entry',
      path,
      name: fileName,
      dir: false,
      parent,
      nameParts: [{ text: fileName, hit: false }]
    })
    group.hits.forEach((hit, index) => {
      const snippet = contentSnippet(hit.text, hit.ranges ?? [])
      rows.push({
        key: `l:${path}:${hit.line}`,
        kind: 'line',
        path,
        name: fileName,
        dir: false,
        parent: '',
        nameParts: [],
        line: hit.line,
        ...(hit.column ? { column: hit.column } : {}),
        text: snippet.text,
        snippet: snippet.parts,
        ellipsis: snippet.ellipsis,
        lead: snippet.lead,
        hit: snippet.hit,
        tail: snippet.tail,
        ...(group.more && index === group.hits.length - 1 ? { more: true } : {})
      })
    })
  }
  return { rows, shown, truncated }
}

export function contentSearchRows(result: FileContentSearchResult): FilesSearchRow[] {
  return groupContentHits(result.hits).rows
}

export type FilesSearchError = 'pattern' | 'permission' | 'missing' | 'invalid' | 'error'

export type FilesSearchLimit = 'results' | 'scan' | null

export function contentSearchError(result: FileContentSearchResult): FilesSearchError | null {
  switch (result.status) {
    case 'ok':
    case 'empty':
    case 'partial':
    case 'cancelled':
      return null
    case 'pattern':
      return 'pattern'
    case 'permission':
    case 'missing':
    case 'invalid':
      return result.status
    default:
      return 'error'
  }
}

export function contentSearchLimit(result: FileContentSearchResult, groups: ContentGroups): FilesSearchLimit {
  const reasons = result.truncation ?? []
  if (reasons.some((reason) => reason !== 'result-limit')) return 'scan'
  if (groups.truncated || reasons.includes('result-limit')) return 'results'
  return result.truncated ? 'scan' : null
}

export function searchStatusFailed(status: string): boolean {
  return status !== 'ok' && status !== 'empty' && status !== 'partial' && status !== 'cancelled'
}

export function nameSearchFailed(result: FileNameSearchResult): boolean {
  return !!result.error && result.error.code !== 'superseded'
}

export function resultDestination(
  key: string,
  index: number,
  rows: ReadonlyArray<Pick<FilesSearchRow, 'kind'>>
): number | 'input' | null {
  const count = rows.length
  if (!count) return key === 'ArrowUp' ? 'input' : null
  switch (key) {
    case 'ArrowDown':
      return index < 0 ? 0 : Math.min(index + 1, count - 1)
    case 'ArrowUp':
      return index <= 0 ? 'input' : index - 1
    case 'Home':
      return 0
    case 'End':
      return count - 1
    case 'ArrowLeft': {
      if (index < 0 || rows[index]?.kind !== 'line') return null
      let at = index - 1
      while (at > 0 && rows[at].kind !== 'entry') at -= 1
      return Math.max(0, at)
    }
    default:
      return null
  }
}
