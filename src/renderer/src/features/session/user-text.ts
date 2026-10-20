export const USER_TEXT_LIMITS = { maxCodeUnits: 200_000, maxFences: 64, maxRuns: 256 }

export type UserTextSegment =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string; lang: string }

const FENCE = /^(`{3,})(\S*)\s*$/
const CLOSING_FENCE = /^\s*(`{3,})\s*$/
const INLINE_CODE = /`([^`\n]+)`/g
const MARKDOWN_LINK = /(?<!\w)\[([^\]\n]+)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\)/g
const BARE_URL = /https?:\/\/[^\s<>]+/g
const TRAILING_PUNCTUATION = /[.,;:!?]$/
const BIDI_CONTROLS = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g

function lineEndAt(text: string, start: number): number {
  const next = text.indexOf('\n', start)
  return next < 0 ? text.length : next
}

function plain(text: string): UserTextSegment[] {
  const trimmed = text.trim()
  return trimmed ? [{ kind: 'text', text: trimmed }] : []
}

export function parseUserSegments(text: string): UserTextSegment[] {
  if (text.length > USER_TEXT_LIMITS.maxCodeUnits) return plain(text)
  if (!text.includes('```')) return plain(text)
  const segments: UserTextSegment[] = []
  let textStart = 0
  let pos = 0
  let fences = 0
  while (pos < text.length) {
    const lineEnd = lineEndAt(text, pos)
    const open = FENCE.exec(text.slice(pos, lineEnd))
    if (open && lineEnd < text.length) {
      let closeStart = -1
      let scan = lineEnd + 1
      while (scan <= text.length) {
        const end = lineEndAt(text, scan)
        const close = CLOSING_FENCE.exec(text.slice(scan, end))
        if (close && close[1].length >= open[1].length) {
          closeStart = scan
          break
        }
        if (end >= text.length) break
        scan = end + 1
      }
      if (closeStart >= 0) {
        if (++fences > USER_TEXT_LIMITS.maxFences) return plain(text)
        const before = text.slice(textStart, pos).trim()
        if (before) segments.push({ kind: 'text', text: before })
        const codeEnd = closeStart > lineEnd + 1 ? closeStart - 1 : lineEnd + 1
        segments.push({ kind: 'code', text: text.slice(lineEnd + 1, codeEnd), lang: open[2] || 'text' })
        const closeEnd = lineEndAt(text, closeStart)
        pos = closeEnd < text.length ? closeEnd + 1 : text.length
        textStart = pos
        continue
      }
    }
    pos = lineEnd + 1
  }
  const tail = text.slice(textStart).trim()
  if (tail) segments.push({ kind: 'text', text: tail })
  if (!segments.length) return plain(text)
  return segments
}

export type UserInlineRun =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; href: string }

export function trimBareUrl(value: string): { href: string; trailing: string } {
  let href = value
  if (TRAILING_PUNCTUATION.test(href)) href = href.slice(0, -1)
  let opening = (href.match(/\(/g) ?? []).length
  let closing = (href.match(/\)/g) ?? []).length
  while (closing > opening && href.endsWith(')')) {
    href = href.slice(0, -1)
    closing -= 1
  }
  return { href, trailing: value.slice(href.length) }
}

function linkable(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

function textRuns(text: string, budget: { count: number }): UserInlineRun[] | null {
  if (!text) return []
  const flat: UserInlineRun[] = [{ kind: 'text', text }]
  if (!text.includes('://')) return flat
  const runs: UserInlineRun[] = []
  let cursor = 0
  const push = (value: string): void => {
    if (value) runs.push({ kind: 'text', text: value })
  }
  if (text.includes('](')) {
    let matched = 0
    MARKDOWN_LINK.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = MARKDOWN_LINK.exec(text))) {
      if (budget.count >= USER_TEXT_LIMITS.maxRuns) return null
      matched += 1
      const target = linkable(match[2])
      if (match.index > cursor) {
        const inner = textRuns(text.slice(cursor, match.index), budget)
        if (inner === null) return null
        runs.push(...inner)
      }
      if (target === null) push(match[0])
      else {
        budget.count += 1
        runs.push({ kind: 'link', text: match[1].replace(BIDI_CONTROLS, ''), href: target })
      }
      cursor = match.index + match[0].length
    }
    if (matched > 0) {
      if (cursor < text.length) {
        const tail = textRuns(text.slice(cursor), budget)
        if (tail === null) return null
        runs.push(...tail)
      }
      return runs
    }
  }
  BARE_URL.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = BARE_URL.exec(text))) {
    if (budget.count >= USER_TEXT_LIMITS.maxRuns) return null
    const { href, trailing } = trimBareUrl(match[0])
    const target = linkable(href)
    if (target === null) continue
    if (match.index > cursor) push(text.slice(cursor, match.index))
    budget.count += 1
    runs.push({ kind: 'link', text: href, href: target })
    if (trailing) push(trailing)
    cursor = match.index + match[0].length
  }
  if (!runs.length) return flat
  push(text.slice(cursor))
  return runs
}

export function parseUserInline(text: string): UserInlineRun[] {
  if (!text) return []
  const whole: UserInlineRun[] = [{ kind: 'text', text }]
  const runs: UserInlineRun[] = []
  const budget = { count: 0 }
  let cursor = 0
  INLINE_CODE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = INLINE_CODE.exec(text))) {
    if (budget.count >= USER_TEXT_LIMITS.maxRuns) return whole
    if (match.index > cursor) {
      const between = textRuns(text.slice(cursor, match.index), budget)
      if (between === null) return whole
      runs.push(...between)
    }
    budget.count += 1
    runs.push({ kind: 'code', text: match[1] })
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) {
    const tail = textRuns(text.slice(cursor), budget)
    if (tail === null) return whole
    runs.push(...tail)
  }
  return runs
}
