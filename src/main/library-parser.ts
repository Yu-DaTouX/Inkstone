/**
 * 资料解析（实施-25 P03 / T03-4）。
 *
 * 解析按序接入：**纯文本 / Markdown → 可提取正文的 PDF → 网页内容**。
 * 没接入的一律明确标 `unsupported`（"仅附件"），不许静默当成"已可阅读"。
 *
 * ## 为什么 PDF 是自己写的而不是引库
 *
 * 需求是「**可提取正文的** PDF」——不是排版还原、不是表单、不是注释。真正要做的是
 * 把内容流解开、把文本操作符里的字符串取出来。自己写这一小段的好处：
 *   · 不引依赖（本项目只有 15 个运行依赖，扫描件/Office 本来也不解析）；
 *   · 失败时能给出**准确原因**（加密 / 扫描件 / CID 字体乱码），而不是一个笼统的 throw；
 *   · 提取不到就如实标 unsupported，符合 §1「状态如实显示」。
 * 代价是复杂版式会丢掉顺序与位置，note 里明确写清楚。
 */
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { inflateSync } from 'node:zlib'
import type { LibraryKind, LibraryParseStatus } from '../shared/library'

export interface ParseOutcome {
  status: LibraryParseStatus
  /** 提取出的正文（`ok` 才有）；由服务层负责落盘 */
  text?: string
  pages?: number
  /** 给人看的说明：为什么是这个状态。不吞原因。 */
  note: string
}

/** 纯文本类：直接读，超过这个大小就只读前面一截（避免把内存打满）。 */
export const MAX_TEXT_BYTES = 4 * 1024 * 1024
/** PDF 上限：超过就标 unsupported（解析会很慢，且多半也不是"资料"）。 */
export const MAX_PDF_BYTES = 64 * 1024 * 1024
/** 提取结果的可打印比例低于此值 → 判定为乱码（典型是 CID 字体 / 扫描件）。 */
const MIN_PRINTABLE_RATIO = 0.6
const MIN_TEXT_CHARS = 20

const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.mdx', '.rst',
  '.json', '.jsonl', '.csv', '.tsv', '.log', '.yaml', '.yml', '.toml', '.ini', '.env',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.rs', '.java', '.kt',
  '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.sh', '.bash', '.ps1', '.sql', '.html', '.htm', '.css'
])
/** 明确「本轮不解析正文」的类型：给准确的说明，而不是含糊的失败。 */
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

/**
 * 解析一个本地文件。
 *
 * 分支顺序有意如此：先按扩展名判"文本类"，再判 PDF，最后落到 `unsupported`。
 * 未知扩展名**不当文本**（二进制当 UTF-8 读会得到一堆替换符，比说"仅附件"更糟）。
 */
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
  try {
    buf = await readFile(filePath)
  } catch (error) {
    return { status: 'failed', note: `读不到文件：${error instanceof Error ? error.message : String(error)}` }
  }
  const truncated = buf.byteLength > MAX_TEXT_BYTES
  const slice = truncated ? buf.subarray(0, MAX_TEXT_BYTES) : buf
  let text = slice.toString('utf8')
  /* 字节被截断时可能切在多字节字符中间，去掉尾部的替换符 */
  if (truncated) text = text.replace(/\uFFFD+$/, '')
  /* HTML 走一遍去标签：直接把标签当正文读给模型，是在浪费上下文 */
  if (ext === '.html' || ext === '.htm') text = extractHtmlText(text).text
  if (!text.trim()) return { status: 'unsupported', note: '文件是空的或只含空白' }
  return {
    status: 'ok',
    text,
    note: truncated ? `已提取正文（超过 ${Math.round(MAX_TEXT_BYTES / 1024 / 1024)}MB，只取了前面一部分）` : '已提取正文'
  }
}

/**
 * 最小 PDF 文本提取。
 *
 * 做法：扫描所有 `stream … endstream` → 该解压的解压（FlateDecode）→
 * 收集内容流里的括号字符串，用 `Td` / `TD` / `T*` 判断换行。
 *
 * ⚠️ 它**不是**排版还原：列顺序、脚注位置、表格结构都会丢。note 里如实说明。
 * 提取不出来时按「没有文本层」或「乱码」区分 —— 这两种对用户的含义完全不同。
 */
async function parsePdf(filePath: string): Promise<ParseOutcome> {
  let buf: Buffer
  try {
    buf = await readFile(filePath)
  } catch (error) {
    return { status: 'failed', note: `读不到文件：${error instanceof Error ? error.message : String(error)}` }
  }
  return parsePdfBuffer(buf)
}

/** 同上，但直接处理内存里的内容（办公文件对比要读 git 里的旧版本，没有磁盘文件） */
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

  const marker = /stream(\r\n|\r|\n)/g
  let hit: RegExpExecArray | null
  while ((hit = marker.exec(raw))) {
    const start = hit.index + hit[0].length
    const end = raw.indexOf('endstream', start)
    if (end < 0) break
    streams += 1
    const slice = buf.subarray(start, end)
    let content = slice.toString('latin1')
    try {
      content = inflateSync(slice).toString('latin1')
      inflated += 1
    } catch {
      /* 未压缩的流：原样使用 */
    }
    const text = extractPdfText(content)
    if (text.trim()) pieces.push(text)
    marker.lastIndex = end
  }

  const text = pieces.join('\n\n').replace(/\n{3,}/g, '\n\n').trim()
  if (streams === 0) return { status: 'failed', pages, note: 'PDF 里没有内容流（文件可能损坏）' }
  if (text.length < MIN_TEXT_CHARS) {
    return { status: 'unsupported', pages, note: 'PDF 里没有可提取的文本层（扫描件或纯图片页），已作为附件保留' }
  }
  if (printableRatio(text) < MIN_PRINTABLE_RATIO) {
    return { status: 'failed', pages, note: '提取出的字符大多是乱码（可能是 CID 内嵌字体或扫描件），已作为附件保留' }
  }
  const how = inflated < streams ? '（含未压缩流）' : ''
  return { status: 'ok', text, pages, note: `已提取正文：${pages} 页${how}；纯文本，不含排版与图片` }
}

/**
 * 从一段内容流里取文本。
 *
 * 括号字符串在 PDF 里就是文本（`(Hi) Tj`、`[(H) -20 (i)] TJ`）：
 *   · 两个文本操作符**之间**出现 `Td` / `TD` / `T*` → 换行；
 *   · 出现 `Tj` / `TJ` → 加空格（两次独立绘制，不连词）；
 *   · 都没有 → 直接拼（同一个 TJ 数组里的分段，拼起来才是词）。
 */
export function extractPdfText(content: string): string {
  const out: string[] = []
  const re = /\([^()]*\)/g
  let last = 0
  let hit: RegExpExecArray | null
  while ((hit = re.exec(content))) {
    const between = content.slice(last, hit.index)
    if (out.length) {
      if (/\bT[dD]\b|\bT\*/.test(between)) out.push('\n')
      else if (/\bTj\b|\bTJ\b/.test(between)) out.push(' ')
    }
    out.push(decodePdfString(hit[0].slice(1, -1)))
    last = hit.index + hit[0].length
  }
  return out.join('').replace(/[ \t]+\n/g, '\n')
}

/** PDF 字符串 → 文本：处理转义、八进制，以及 UTF-16BE 的 BOM。 */
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

/** 可打印比例：用来识别「解出来一堆乱码」的情况（CID 字体/扫描件的典型症状）。 */
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

/**
 * 网页正文提取（T03-4 的第三档）。
 *
 * 只做「去标签 + 解实体 + 保留段落换行」——不做正文识别（Readability 那类）。
 * 理由：这里是**用户自己提供的网页**，不是全网抓取；多留一点导航文字比
 * 误删正文段落更安全，note 里也说明了这一点。
 */
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
    if (ENTITIES[key] !== undefined) return ENTITIES[key]
    if (key.startsWith('#x')) {
      const code = parseInt(key.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    if (key.startsWith('#')) {
      const code = parseInt(key.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
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

/** 网页正文的可读性判断：太短的多半是登录页 / 跳转页，如实标出来。 */
export function htmlParseOutcome(html: string): ParseOutcome {
  const { text } = extractHtmlText(html)
  if (text.length < MIN_TEXT_CHARS) {
    return { status: 'unsupported', note: '网页内容太短（可能是需要登录或动态加载的页面），只保留了链接' }
  }
  return { status: 'ok', text, note: '已提取网页正文（去标签后的纯文本，未做正文识别）' }
}
