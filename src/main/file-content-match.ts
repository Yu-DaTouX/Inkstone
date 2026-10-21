const MAX_REGEX_LINE = 1000

const WORD_CLASS = '[\\p{L}\\p{N}_]'
const WORD_CHAR = /[\p{L}\p{N}_]/u

export interface ContentSearchOptions {
  matchCase?: boolean
  wholeWord?: boolean
  regexp?: boolean
}

export interface ContentMatcher {
  skips(line: string): boolean
  match(line: string): Array<[number, number]>
}

export interface ContentLineMatch {
  file: number
  line: number
  ranges: Array<[number, number]>
}

export interface ContentMatchJob {
  query: string
  options: ContentSearchOptions
  texts: string[]
  limit: number
}

export interface ContentMatchOutcome {
  matches: ContentLineMatch[]
  longLines: number
  limitReached: boolean
  cancelled?: boolean
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function compileContentMatcher(query: string, options: ContentSearchOptions = {}): ContentMatcher | null {
  if (!query) return null
  if (!options.regexp && query.includes('\n')) return null
  const flags = options.matchCase ? 'gu' : 'giu'
  let source = options.regexp ? query : escapeRegExp(query)
  try {
    new RegExp(source, flags)
  } catch {
    return null
  }
  if (options.wholeWord) {
    const chars = [...query]
    const wordEdge = (char: string | undefined): boolean => !!options.regexp || (char !== undefined && WORD_CHAR.test(char))
    source = `${wordEdge(chars[0]) ? `(?<!${WORD_CLASS})` : ''}(?:${source})${wordEdge(chars[chars.length - 1]) ? `(?!${WORD_CLASS})` : ''}`
  }
  const pattern = new RegExp(source, flags)
  const regexp = !!options.regexp
  return {
    skips: (line) => regexp && line.length > MAX_REGEX_LINE,
    match: (line) => {
      const ranges: Array<[number, number]> = []
      pattern.lastIndex = 0
      for (let found = pattern.exec(line); found !== null; found = pattern.exec(line)) {
        if (found[0].length === 0) {
          pattern.lastIndex += (line.codePointAt(found.index) ?? 0) > 0xffff ? 2 : 1
          continue
        }
        ranges.push([found.index, found.index + found[0].length])
      }
      return ranges
    }
  }
}

export function splitContentLines(text: string): string[] {
  return text.split(/\r\n?|\n/)
}

export function matchContentLines(
  matcher: ContentMatcher,
  texts: string[],
  limit: number,
  shouldStop: () => boolean = () => false
): ContentMatchOutcome {
  const matches: ContentLineMatch[] = []
  let longLines = 0
  let limitReached = false
  for (let file = 0; file < texts.length; file += 1) {
    if (shouldStop()) return { matches, longLines, limitReached, cancelled: true }
    const lines = splitContentLines(texts[file])
    for (let index = 0; index < lines.length; index += 1) {
      if (shouldStop()) return { matches, longLines, limitReached, cancelled: true }
      const line = lines[index]
      if (matcher.skips(line)) {
        longLines += 1
        continue
      }
      const ranges = matcher.match(line)
      if (!ranges.length) continue
      matches.push({ file, line: index + 1, ranges })
      if (matches.length >= limit) {
        limitReached = true
        return { matches, longLines, limitReached }
      }
    }
  }
  return { matches, longLines, limitReached }
}
