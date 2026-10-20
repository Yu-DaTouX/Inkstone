export interface SlashQueryRange {
  query: string
  start: number
  end: number
}

export interface SlashQueryOptions {
  inCode?: boolean
}

export const SLASH_QUERY_MAX = 50

export function findSlashQuery(
  value: string,
  cursor: number = value.length,
  options: SlashQueryOptions = {}
): SlashQueryRange | null {
  if (options.inCode) return null
  const end = Math.max(0, Math.min(cursor, value.length))
  const lineStart = value.lastIndexOf('\n', Math.max(0, end - 1)) + 1
  const slash = value.lastIndexOf('/', end - 1)
  if (slash < lineStart) return null

  const before = value.slice(lineStart, slash)
  const atLineStart = /^[ \t]*$/.test(before)
  if (!atLineStart && !/[ \t]$/.test(before)) return null

  const query = value.slice(slash + 1, end)
  if (query.length > SLASH_QUERY_MAX) return null
  if (/[\s]/.test(query)) return null
  if (query ? !/^[A-Za-z0-9]/.test(query) : !atLineStart) return null

  return { query, start: slash + 1, end }
}

export function replaceSlashQuery(
  value: string,
  range: SlashQueryRange,
  name: string
): { value: string; cursor: number } {
  const suffix = value.slice(range.end)
  const tail = suffix.length === 0 ? ' ' : ''
  const nextValue = `${value.slice(0, range.start)}${name}${tail}${suffix}`
  return { value: nextValue, cursor: range.start + name.length + tail.length }
}
