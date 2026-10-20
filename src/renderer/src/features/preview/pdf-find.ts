import { FIND_MATCH_LIMIT, findMatches, type FindOptions } from './code-find'

export interface PdfFindMatch {
  page: number
  line: number
  start: number
  end: number
}

export interface PdfFindResult {
  matches: PdfFindMatch[]
  invalid: boolean
  capped: boolean
}

export interface PdfTextItem {
  str?: string
  hasEOL?: boolean
}

export function pdfTextLines(items: readonly PdfTextItem[]): string[] {
  const lines: string[] = []
  let current = ''
  for (const item of items) {
    if (typeof item.str === 'string') current += item.str
    if (item.hasEOL) {
      lines.push(current)
      current = ''
    }
  }
  if (current) lines.push(current)
  return lines
}

export function pdfFindMatches(
  pages: readonly (readonly string[])[],
  query: string,
  options: FindOptions,
  limit = FIND_MATCH_LIMIT
): PdfFindResult {
  if (!query) return { matches: [], invalid: false, capped: false }
  const matches: PdfFindMatch[] = []
  let invalid = false
  let capped = false
  for (let page = 0; page < pages.length; page += 1) {
    const remaining = limit - matches.length
    if (remaining <= 0) {
      capped = true
      break
    }
    const result = findMatches(pages[page], query, options, remaining)
    if (result.invalid) invalid = true
    if (result.capped) capped = true
    for (const match of result.matches) {
      matches.push({ page, line: match.line, start: match.start, end: match.end })
    }
  }
  return { matches, invalid, capped }
}

export function pdfMatchPage(matches: readonly PdfFindMatch[], index: number): number {
  if (!matches.length) return -1
  const at = Math.max(0, Math.min(matches.length - 1, index))
  return matches[at].page
}

export function pdfMatchPages(matches: readonly PdfFindMatch[]): Map<number, PdfFindMatch[]> {
  const byPage = new Map<number, PdfFindMatch[]>()
  for (const match of matches) {
    const list = byPage.get(match.page)
    if (list) list.push(match)
    else byPage.set(match.page, [match])
  }
  return byPage
}
