export interface SlashQueryRange {
  query: string
  start: number
  end: number
}

export function findSlashQuery(value: string, cursor: number = value.length): SlashQueryRange | null {
  const end = Math.max(0, Math.min(cursor, value.length))
  const before = value.slice(0, end)
  const match = /^[ \t]*\/([^\s]*)/.exec(before)
  if (!match) return null

  const query = match[1] ?? ''
  const start = match[0].indexOf('/') + 1
  const tokenEnd = start + query.length

  if (end > tokenEnd) return null
  return { query, start, end: tokenEnd }
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
