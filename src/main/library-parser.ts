import { open, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { inflateSync } from 'node:zlib'
import type { LibraryKind, LibraryParseStatus } from '../shared/library'

export interface ParseOutcome {
  status: LibraryParseStatus
  text?: string
  pages?: number
  note: string
}

export const MAX_TEXT_BYTES = 4 * 1024 * 1024
export const MAX_PDF_BYTES = 64 * 1024 * 1024
export const MAX_PDF_STREAM_BYTES = 16 * 1024 * 1024
export const MAX_PDF_TOTAL_BYTES = 64 * 1024 * 1024
const MIN_PRINTABLE_RATIO = 0.6
const MIN_TEXT_CHARS = 20

const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.mdx', '.rst',
  '.json', '.jsonl', '.csv', '.tsv', '.log', '.yaml', '.yml', '.toml', '.ini', '.env',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.rs', '.java', '.kt',
  '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.sh', '.bash', '.ps1', '.sql', '.html', '.htm', '.css'
])
const OPAQUE_EXT: Record<string, string> = {
  '.pdf': 'PDF',
  '.doc': 'Word 旧格式', '.docx': 'Word', '.rtf': 'RTF',
  '.ppt': 'PowerPoint 旧格式', '.pptx': 'PowerPoint',
  '.xls': 'Excel 旧格式', '.xlsx': 'Excel',
  '.png': '图片', '.jpg': '图片', '.jpeg': '图片', '.gif': '图片', '.webp': '图片', '.bmp': '图片', '.heic': '图片',
  '.zip': '压缩包', '.7z': '压缩包', '.rar': '压缩包', '.tar': '压缩包', '.gz': '压缩包',
  '.mp3': '音频', '.wav': '音频', '.m4a': '音频', '.mp4': '视频', '.mov': '视频', '.mkv': '视频'
}

export function isTextLike(filePath: string): boolean {
  return TEXT_EXT.has(extname(filePath).toLowerCase())
}

export async function parseLibraryFile(filePath: string, kind: LibraryKind): Promise<ParseOutcome> {
  const ext = extname(filePath).toLowerCase()
  if (kind === 'image') {
    return { status: 'unsupported', note: '图片作为附件保留；正文提取（OCR）尚未接入' }
  }
  if (ext === '.pdf') return parsePdf(filePath)
  if (isTextLike(filePath)) return parsePlainText(filePath, ext)
  const label = OPAQUE_EXT[ext] ?? (ext ? `${ext} 文件` : '无扩展名文件')
  return { status: 'unsupported', note: `${label}的正文提取尚未接入，已作为附件保留` }
}

async function parsePlainText(filePath: string, ext: string): Promise<ParseOutcome> {
  let buf: Buffer
  let truncated: boolean
  try {
    const info = await stat(filePath)
    if (!info.isFile()) return { status: 'failed', note: '不是普通文件' }
    truncated = info.size > MAX_TEXT_BYTES
    const handle = await open(filePath, 'r')
    try {
      buf = Buffer.alloc(Math.min(info.size, MAX_TEXT_BYTES))
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
      buf = buf.subarray(0, bytesRead)
      truncated ||= bytesRead < info.size
    } finally { await handle.close() }
  } catch (error) {
    return { status: 'failed', note: `读不到文件：${error instanceof Error ? error.message : String(error)}` }
  }
  const slice = buf
  let text = slice.toString('utf8')
  if (truncated) text = text.replace(/\uFFFD+$/, '')
  if (ext === '.html' || ext === '.htm') text = extractHtmlText(text).text
  if (!text.trim()) return { status: 'unsupported', note: '文件是空的或只含空白' }
  return {
    status: 'ok',
    text,
    note: truncated ? `已提取正文（超过 ${Math.round(MAX_TEXT_BYTES / 1024 / 1024)}MB，只取了前面一部分）` : '已提取正文'
  }
}

async function parsePdf(filePath: string): Promise<ParseOutcome> {
  let buf: Buffer
  try {
    const info = await stat(filePath)
    if (!info.isFile()) return { status: 'failed', note: '不是普通文件' }
    if (info.size > MAX_PDF_BYTES) return { status: 'unsupported', note: `PDF 超过 ${Math.round(MAX_PDF_BYTES / 1024 / 1024)}MB，仅作为附件保留` }
    buf = Buffer.alloc(info.size)
    const handle = await open(filePath, 'r')
    try {
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
      if (bytesRead !== info.size) return { status: 'failed', note: 'PDF 在读取期间发生变化，请重试' }
    } finally { await handle.close() }
  } catch (error) {
    return { status: 'failed', note: `读不到文件：${error instanceof Error ? error.message : String(error)}` }
  }
  return parsePdfBuffer(buf)
}

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

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' '
}

export function extractHtmlText(html: string): { text: string; title?: string } {
  const titleHit = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  const title = titleHit ? titleHit[1].replace(/\s+/g, ' ').trim() : undefined
  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
  body = body.replace(/<[^>]*>/g, ' ')
  body = body.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole: string, name: string) => {
    const key = name.toLowerCase()
    if (Object.hasOwn(ENTITIES, key)) return ENTITIES[key]
    if (key.startsWith('#x')) {
      const code = parseInt(key.slice(2), 16)
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    if (key.startsWith('#')) {
      const code = parseInt(key.slice(1), 10)
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return whole
  })
  return {
    title,
    text: body
      .replace(/[ \t]+/g, ' ')
      .replace(/ ?\n ?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }
}

export function htmlParseOutcome(html: string): ParseOutcome {
  const { text } = extractHtmlText(html)
  if (text.length < MIN_TEXT_CHARS) {
    return { status: 'unsupported', note: '网页内容太短（可能是需要登录或动态加载的页面），只保留了链接' }
  }
  return { status: 'ok', text, note: '已提取网页正文（去标签后的纯文本，未做正文识别）' }
}
