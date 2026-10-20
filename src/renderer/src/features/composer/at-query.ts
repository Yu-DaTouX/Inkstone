export interface AtQueryRange {
  query: string
  start: number
  end: number
  quoted: boolean
  quote?: '"' | "'"
}

export interface AtQueryOptions {
  inCode?: boolean
}

export function findAtQuery(
  value: string,
  cursor: number = value.length,
  options: AtQueryOptions = {}
): AtQueryRange | null {
  if (options.inCode) return null
  const end = Math.max(0, Math.min(cursor, value.length))
  const isBoundary = (char: string | undefined): boolean =>
    !char || /[\s([{<'"：:;,，]/.test(char)
  const isEscaped = (at: number): boolean => {
    let slashes = 0
    for (let i = at - 1; i >= 0 && value[i] === '\\'; i -= 1) slashes += 1
    return slashes % 2 === 1
  }

  let at = -1
  for (let i = end - 1; i >= 0; i -= 1) {
    if (value[i] !== '@' || isEscaped(i) || !isBoundary(value[i - 1])) continue
    at = i
    break
  }
  if (at < 0) return null

  const tokenStart = at + 1
  const first = value[tokenStart]
  if (first === '"' || first === "'") {
    for (let i = tokenStart + 1; i < end; i += 1) {
      if (value[i] !== first) continue
      const after = value.slice(i + 1, end)
      if (!after || /^[\s)\]}>,.;:!?，。！？]*$/.test(after)) {
        return {
          query: value.slice(tokenStart + 1, i),
          start: tokenStart,
          end: i + 1,
          quoted: true,
          quote: first
        }
      }
    }
    return {
      query: value.slice(tokenStart + 1, end),
      start: tokenStart,
      end,
      quoted: true,
      quote: first
    }
  }

  return { query: value.slice(tokenStart, end), start: tokenStart, end, quoted: false }
}

export function replaceAtQuery(value: string, range: AtQueryRange, path: string): { value: string; cursor: number } {
  const quote = range.quoted || /\s/.test(path)
  const quoteChar = range.quote ?? '"'
  const replacement = quote ? `${quoteChar}${path}${quoteChar}` : path
  const nextValue = `${value.slice(0, range.start)}${replacement}${value.slice(range.end)}`
  return { value: nextValue, cursor: range.start + replacement.length }
}
