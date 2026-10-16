import { inflateSync } from 'node:zlib'

export type PdfParseStatus = 'ok' | 'unsupported' | 'failed'

export interface ParseOutcome {
  status: PdfParseStatus
  text?: string
  pages?: number
  note: string
}

export const MAX_PDF_BYTES = 64 * 1024 * 1024
export const MAX_PDF_STREAM_BYTES = 16 * 1024 * 1024
export const MAX_PDF_TOTAL_BYTES = 64 * 1024 * 1024
const MIN_PRINTABLE_RATIO = 0.6
const MIN_TEXT_CHARS = 20

export function parsePdfBuffer(buf: Buffer): ParseOutcome {
  if (buf.byteLength > MAX_PDF_BYTES) {
    return { status: 'unsupported', note: `PDF 超过 ${Math.round(MAX_PDF_BYTES / 1024 / 1024)}MB，仅作为附件保留` }
  }
  const raw = buf.toString('latin1')
  if (!raw.slice(0, 1024).includes('%PDF-')) return { status: 'failed', note: '不是 PDF（缺少 %PDF- 文件头）' }
  if (/\/Encrypt\b/.test(raw)) return { status: 'failed', note: 'PDF 已加密，无法提取正文' }

  const pages = Math.max(1, (raw.match(/\/Type\s*\/Page\b/g) ?? []).length)
  const pieces: string[] = []
  let streams = 0
  let inflated = 0
  let produced = 0
  let skipped = 0

  const marker = /(?<![A-Za-z])stream(\r\n|\r|\n)/g
  let hit: RegExpExecArray | null
  while ((hit = marker.exec(raw))) {
    const start = hit.index + hit[0].length
    const end = raw.indexOf('endstream', start)
    if (end < 0) break
    streams += 1
    const slice = buf.subarray(start, end)
    const declaredFlate = /\/Filter\s*(?:\[\s*)?\/FlateDecode\b/.test(raw.slice(Math.max(0, hit.index - 2048), hit.index))
    let content = ''
    const remaining = MAX_PDF_TOTAL_BYTES - produced
    if (remaining <= 0) {
      skipped += 1
      marker.lastIndex = end + 'endstream'.length
      continue
    }
    try {
      content = inflateSync(slice, { maxOutputLength: Math.min(MAX_PDF_STREAM_BYTES, remaining) }).toString('latin1')
      inflated += 1
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      if (code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength/i.test(error instanceof Error ? error.message : '')) {
        skipped += 1
        marker.lastIndex = end + 'endstream'.length
        continue
      }
      if (declaredFlate) {
        skipped += 1
        marker.lastIndex = end + 'endstream'.length
        continue
      }
      content = slice.toString('latin1')
    }
    produced += content.length
    const text = extractPdfText(content)
    if (text.trim()) pieces.push(text)
    marker.lastIndex = end + 'endstream'.length
  }

  const text = pieces.join('\n\n').replace(/\n{3,}/g, '\n\n').trim()
  if (streams === 0) return { status: 'failed', pages, note: 'PDF 里没有内容流（文件可能损坏）' }
  const skippedNote = skipped > 0 ? `（${skipped} 个内容流超出预算或解压失败，已跳过）` : ''
  if (text.length < MIN_TEXT_CHARS) {
    if (skipped > 0 && !pieces.length) {
      return { status: 'failed', pages, note: `内容流超出预算或解压失败${skippedNote}，没有可用的文本层` }
    }
    return { status: 'unsupported', pages, note: `PDF 里没有可提取的文本层（扫描件或纯图片页），已作为附件保留${skippedNote}` }
  }
  if (printableRatio(text) < MIN_PRINTABLE_RATIO) {
    return { status: 'failed', pages, note: `提取出的字符大多是乱码（可能是 CID 内嵌字体或扫描件），已作为附件保留${skippedNote}` }
  }
  const how = inflated < streams ? '（含未压缩流）' : ''
  return { status: 'ok', text, pages, note: `已提取正文：${pages} 页${how}；纯文本，不含排版与图片${skippedNote}` }
}

export function extractPdfText(content: string): string {
  const out: string[] = []
  let last = 0
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] !== '(') continue
    const start = i
    let depth = 1
    let escaped = false
    for (i += 1; i < content.length && depth > 0; i += 1) {
      const ch = content[i]
      if (escaped) { escaped = false; continue }
      if (ch === String.fromCharCode(92)) { escaped = true; continue }
      if (ch === '(') depth += 1
      else if (ch === ')') depth -= 1
    }
    if (depth !== 0) break
    const end = i
    const between = content.slice(last, start)
    if (out.length) {
      if (/\bT[dD]\b|\bT\*/.test(between)) out.push('\n')
      else if (/\bTj\b|\bTJ\b/.test(between)) out.push(' ')
    }
    out.push(decodePdfString(content.slice(start + 1, end - 1)))
    last = end
    i -= 1
  }
  return out.join('').replace(/[ \t]+\n/g, '\n')
}

export function decodePdfString(body: string): string {
  const backslash = String.fromCharCode(92)
  const bytes: number[] = []
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]
    if (ch !== backslash) {
      bytes.push(body.charCodeAt(i) & 0xff)
      continue
    }
    const next = body[i + 1]
    if (next === undefined) break
    i += 1
    if (next === 'n') bytes.push(10)
    else if (next === 'r') bytes.push(13)
    else if (next === 't') bytes.push(9)
    else if (next === 'b') bytes.push(8)
    else if (next === 'f') bytes.push(12)
    else if (next >= '0' && next <= '7') {
      let oct = next
      while (oct.length < 3 && body[i + 1] >= '0' && body[i + 1] <= '7') {
        oct += body[i + 1]
        i += 1
      }
      bytes.push(parseInt(oct, 8) & 0xff)
    } else bytes.push(next.charCodeAt(0) & 0xff)
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const rest = Buffer.from(bytes.slice(2))
    if (rest.length % 2 === 1) return rest.toString('latin1')
    rest.swap16()
    return rest.toString('utf16le')
  }
  return Buffer.from(bytes).toString('latin1')
}

const PRINTABLE = /[\p{L}\p{N}\p{P}\p{Zs}]/u

export function printableRatio(text: string): number {
  const chars = [...text]
  if (!chars.length) return 0
  let good = 0
  for (const ch of chars) {
    if (ch === '\n' || PRINTABLE.test(ch)) good += 1
  }
  return good / chars.length
}
