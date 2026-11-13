import { escapeRegExp } from '../shared/escape'

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
