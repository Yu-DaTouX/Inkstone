export const BRIEF_FOLD_CHARS = 1200
export const BRIEF_FOLD_LINES = 16

export interface BriefFold {
  preview: string
  total: number
}

function cutAt(text: string, end: number): string {
  if (end >= text.length) return text
  const code = text.charCodeAt(end - 1)
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? end - 1 : end)
}

export function foldBrief(text: string, maxChars = BRIEF_FOLD_CHARS, maxLines = BRIEF_FOLD_LINES): BriefFold | null {
  let lineEnd = -1
  let lines = 0
  while (lines < maxLines) {
    const next = text.indexOf('\n', lineEnd + 1)
    if (next < 0) {
      lineEnd = -1
      break
    }
    lineEnd = next
    lines += 1
  }
  const byLines = lines >= maxLines && lineEnd >= 0 ? lineEnd : text.length
  const end = Math.min(byLines, maxChars)
  if (end >= text.length || !text.slice(end).trim()) return null
  return { preview: cutAt(text, end).trimEnd(), total: [...text].length }
}
