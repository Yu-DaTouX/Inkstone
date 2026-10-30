import type { FileContentSearchResult } from '../../../../shared/ipc'
import type { FileNameSearchResult } from '../../../../shared/file-name-search'
import type { CommandItem } from './command-items'

export const FILE_RESULT_LIMIT = 50
export const CONTENT_RESULT_LIMIT = 80
export const CONTENT_SNIPPET_MAX = 96
export const FILE_QUERY_DELAY = 120
export const CONTENT_QUERY_DELAY = 250

export type FileSearchIssue = 'failed' | 'pattern' | null

function splitPath(path: string): { parent: string; name: string } {
  const clean = path.replace(/\\/g, '/').replace(/\/+$/, '')
  const at = clean.lastIndexOf('/')
  return at < 0 ? { parent: '', name: clean } : { parent: clean.slice(0, at), name: clean.slice(at + 1) }
}

export function contentSnippetText(text: string, ranges: ReadonlyArray<readonly [number, number]> = [], max = CONTENT_SNIPPET_MAX): string {
  const first = ranges[0]
  let start = 0
  if (first && first[0] > max / 3) {
    start = Math.max(0, first[0] - Math.floor(max / 3))
    const space = text.slice(start, first[0]).search(/\s/)
    if (space >= 0) start += space + 1
  }
  const flat = text.slice(start).replace(/\s+/g, ' ').trim()
  const lead = start > 0 ? '…' : ''
  if (flat.length + lead.length <= max) return `${lead}${flat}`
  return `${lead}${flat.slice(0, Math.max(1, max - lead.length - 1))}…`
}

export function fileNameItems(result: FileNameSearchResult, limit = FILE_RESULT_LIMIT): CommandItem[] {
  return result.matches
    .filter((match) => !match.directory)
    .slice(0, limit)
    .map((match) => {
      const path = match.path.replace(/\\/g, '/')
      const { parent, name } = splitPath(path)
      return {
        id: `file:${path}`,
        group: 'file' as const,
        label: name || match.name,
        keywords: path.toLowerCase(),
        filePath: path,
        meta: parent
      }
    })
}

export function contentHitItems(result: FileContentSearchResult, limit = CONTENT_RESULT_LIMIT): CommandItem[] {
  const seen = new Set<string>()
  const items: CommandItem[] = []
  for (const hit of result.hits) {
    if (items.length >= limit) break
    const path = hit.path.replace(/\\/g, '/')
    const id = `content:${path}:${hit.line}`
    if (seen.has(id)) continue
    seen.add(id)
    const { name } = splitPath(path)
    items.push({
      id,
      group: 'content',
      label: contentSnippetText(hit.text, hit.ranges ?? []) || name,
      keywords: path.toLowerCase(),
      filePath: path,
      line: hit.line,
      ...(hit.column ? { column: hit.column } : {}),
      meta: `${name || hit.name}:${hit.line}`
    })
  }
  return items
}

export function fileNameIssue(result: FileNameSearchResult): FileSearchIssue {
  if (!result.error || result.error.code === 'superseded') return null
  return 'failed'
}

export function contentIssue(result: FileContentSearchResult): FileSearchIssue {
  switch (result.status) {
    case 'ok':
    case 'empty':
    case 'partial':
    case 'cancelled':
      return null
    case 'pattern':
      return 'pattern'
    default:
      return 'failed'
  }
}

export function contentTruncated(result: FileContentSearchResult, limit = CONTENT_RESULT_LIMIT): boolean {
  return result.truncated || (result.truncation?.length ?? 0) > 0 || result.hits.length > limit
}
