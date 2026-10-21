type ImageRefPrefix = '图' | 'img'

const REF = /@(图|img)(\d+)(?!\d)/gi
const REMOVED_REF = /@(图|img)\?/gi
const LEGEND_ZH = /\n*（附图按添加顺序编号：[^\n]*）/g
const LEGEND_EN = /\n*\(Images are numbered in attachment order: [^\n]*\)/g

export function imageRefPrefix(locale: string): ImageRefPrefix {
  return locale.toLowerCase().startsWith('zh') ? '图' : 'img'
}

export function imageRefLabel(prefix: ImageRefPrefix, n: number): string {
  return `${prefix}${n}`
}

export function imageRefMatches(prefix: ImageRefPrefix, count: number, query: string): number[] {
  const q = query.trim().toLowerCase()
  const all = Array.from({ length: count }, (_, i) => i + 1)
  if (!q) return all
  return all.filter((n) => {
    const digits = String(n)
    return digits.startsWith(q) || `${prefix}${digits}`.startsWith(q) || `图${digits}`.startsWith(q) || `img${digits}`.startsWith(q)
  })
}

export function renumberImageRefsAfterRemoval(text: string, removed: number): string {
  return text.replace(REF, (whole, prefix: string, digits: string) => {
    const n = Number(digits)
    if (n === removed) return `@${prefix}?`
    if (n > removed) return `@${prefix}${n - 1}`
    return whole
  })
}

export function usedImageRefPrefix(text: string): ImageRefPrefix | null {
  const first = text.matchAll(REF).next().value
  if (!first) return null
  return first[1] === '图' ? '图' : 'img'
}

export function referencedImageNumbers(text: string): number[] {
  const found = new Set<number>()
  for (const match of text.matchAll(REF)) found.add(Number(match[2]))
  return [...found].sort((a, b) => a - b)
}

export function brokenImageRefs(text: string, imageCount: number): { missing: number[]; removed: number } {
  const missing = referencedImageNumbers(text).filter((n) => n < 1 || n > imageCount)
  const removed = [...text.matchAll(REMOVED_REF)].length
  return { missing, removed }
}

export function stripImageLegend(text: string): string {
  return text.replace(LEGEND_ZH, '').replace(LEGEND_EN, '')
}

export function withImageLegend(text: string, imageCount: number, prefix: ImageRefPrefix): string {
  const body = stripImageLegend(text)
  if (imageCount === 0 || referencedImageNumbers(body).length === 0) return body
  const labels = Array.from({ length: imageCount }, (_, i) => imageRefLabel(prefix, i + 1))
  const legend = prefix === '图'
    ? `（附图按添加顺序编号：${labels.join('、')}）`
    : `(Images are numbered in attachment order: ${labels.join(', ')})`
  return `${body}\n\n${legend}`
}

export function splitImageRefs(text: string): Array<{ text: string; ref?: number }> {
  const parts: Array<{ text: string; ref?: number }> = []
  let last = 0
  for (const match of text.matchAll(REF)) {
    const start = match.index ?? 0
    if (start > last) parts.push({ text: text.slice(last, start) })
    parts.push({ text: match[0], ref: Number(match[2]) })
    last = start + match[0].length
  }
  if (last < text.length) parts.push({ text: text.slice(last) })
  return parts
}
