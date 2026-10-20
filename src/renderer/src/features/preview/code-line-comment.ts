export type CommentLang = 'zh-CN' | 'en-US'

export interface LineCommentRange {
  start: number
  end: number
}

export interface LineCommentInput {
  path: string
  start: number
  end: number
  code: string
  text: string
  lang: CommentLang
}

export const COMMENT_QUOTE_MAX_LINES = 40

export function commentRange(anchor: number, focus: number, lineCount: number): LineCommentRange | null {
  if (!Number.isInteger(anchor) || !Number.isInteger(focus)) return null
  if (!Number.isInteger(lineCount) || lineCount < 1) return null
  const first = Math.min(anchor, focus)
  const last = Math.max(anchor, focus)
  if (first < 1 || first > lineCount) return null
  return { start: first, end: Math.min(last, lineCount) }
}

export function commentQuoteLines(
  texts: readonly string[],
  firstNumber: number,
  range: LineCommentRange,
  maxLines = COMMENT_QUOTE_MAX_LINES
): string[] {
  const from = Math.max(0, range.start - firstNumber)
  const to = Math.min(texts.length - 1, range.end - firstNumber)
  if (to < from) return []
  const lines = texts.slice(from, to + 1).map((text) => text.replace(/\r$/, ''))
  if (lines.length <= maxLines) return lines
  return [...lines.slice(0, maxLines - 1), '…']
}

export function lineCommentLabel(range: LineCommentRange, lang: CommentLang): string {
  if (range.start === range.end) return lang === 'en-US' ? `Line ${range.start}` : `第 ${range.start} 行`
  return lang === 'en-US' ? `Lines ${range.start}–${range.end}` : `第 ${range.start}–${range.end} 行`
}

function quote(code: string): string {
  return code
    .replace(/\r\n?/g, '\n')
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
}

export function serializeLineComment({ path, start, end, code, text, lang }: LineCommentInput): string {
  const body = String(text ?? '').trim()
  if (!body) return ''
  const target = path.replace(/\\/g, '/')
  const range = end > start
  const where =
    lang === 'en-US'
      ? range
        ? `In ${target}, lines ${start}–${end}:`
        : `In ${target}, line ${start}:`
      : range
        ? `在 ${target} 第 ${start}–${end} 行：`
        : `在 ${target} 第 ${start} 行：`
  const quoted = code.trim() ? quote(code) : ''
  return [where, quoted, body].filter(Boolean).join('\n')
}
