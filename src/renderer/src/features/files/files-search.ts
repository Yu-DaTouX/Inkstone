import type { FileContentSearchResult, FileSearchResult } from '../../../../shared/ipc'

export const CONTENT_QUERY_PREFIX = '?'

export type FilesQueryMode = 'name' | 'content'

export interface FilesQuery {
  mode: FilesQueryMode
  query: string
}

export function parseFilesQuery(raw: string): FilesQuery {
  const trimmed = raw.trim()
  if (trimmed.startsWith(CONTENT_QUERY_PREFIX)) {
    return { mode: 'content', query: trimmed.slice(CONTENT_QUERY_PREFIX.length).trim() }
  }
  return { mode: 'name', query: trimmed }
}

export interface FilesSearchRow {
  key: string
  path: string
  name: string
  dir: boolean
  line?: number
  text?: string
}

export function nameSearchRows(result: FileSearchResult): FilesSearchRow[] {
  return result.entries.map((entry) => ({ key: entry.path, path: entry.path, name: entry.name, dir: entry.dir }))
}

export function contentSearchRows(result: FileContentSearchResult): FilesSearchRow[] {
  return result.hits.map((hit) => ({
    key: `${hit.path}:${hit.line}`,
    path: hit.path,
    name: hit.name,
    dir: false,
    line: hit.line,
    text: hit.text
  }))
}

export function searchStatusFailed(status: string): boolean {
  return status !== 'ok' && status !== 'empty' && status !== 'partial' && status !== 'cancelled'
}
