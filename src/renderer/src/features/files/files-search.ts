import type { FileContentSearchResult } from '../../../../shared/ipc'
import type { FileNameSearchResult } from '../../../../shared/file-name-search'

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
  text?: string
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

export function contentSearchRows(result: FileContentSearchResult): FilesSearchRow[] {
  const rows: FilesSearchRow[] = []
  let current = ''
  for (const hit of result.hits) {
    if (hit.path !== current) {
      current = hit.path
      const { parent, name } = splitTreePath(hit.path)
      rows.push({
        key: `f:${hit.path}`,
        kind: 'entry',
        path: hit.path,
        name: name || hit.name,
        dir: false,
        parent,
        nameParts: [{ text: name || hit.name, hit: false }]
      })
    }
    rows.push({
      key: `l:${hit.path}:${hit.line}`,
      kind: 'line',
      path: hit.path,
      name: hit.name,
      dir: false,
      parent: '',
      nameParts: [],
      line: hit.line,
      text: hit.text.trim()
    })
  }
  return rows
}

export function searchStatusFailed(status: string): boolean {
  return status !== 'ok' && status !== 'empty' && status !== 'partial' && status !== 'cancelled'
}

export function nameSearchFailed(result: FileNameSearchResult): boolean {
  return !!result.error && result.error.code !== 'superseded'
}
