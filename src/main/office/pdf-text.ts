import { openPdfDocument } from '../search/pdf-content'

export type PdfParseStatus = 'ok' | 'unsupported' | 'failed'

export interface ParseOutcome {
  status: PdfParseStatus
  text?: string
  pages?: number
  note: string
}

export const MAX_PDF_BYTES = 64 * 1024 * 1024
export const MAX_PDF_PAGES = 500
export const MAX_PDF_TEXT_CHARS = 4 * 1024 * 1024
const MIN_TEXT_CHARS = 20

const PDF_ERROR_NOTES: Record<string, string> = {
  PasswordException: 'PDF 已加密，无法提取正文',
  InvalidPDFException: 'PDF 无法解析（文件可能损坏），已作为附件保留',
  MissingPDFException: 'PDF 内容不完整（缺少必要的对象），已作为附件保留',
  UnexpectedResponseException: 'PDF 读取失败，已作为附件保留'
}

function pdfErrorNote(error: unknown): string {
  const name = (error as { name?: string } | null | undefined)?.name
  return (name && PDF_ERROR_NOTES[name]) ?? `PDF 解析失败：${error instanceof Error ? error.message : String(error)}`
}

function declaresEncryption(buf: Buffer): boolean {
  const needle = Buffer.from('/Encrypt', 'latin1')
  for (let at = buf.indexOf(needle); at >= 0; at = buf.indexOf(needle, at + 1)) {
    const next = buf[at + needle.length]
    if (next !== undefined && !/[A-Za-z0-9_]/.test(String.fromCharCode(next))) return true
  }
  return false
}

export async function parsePdfBuffer(buf: Buffer): Promise<ParseOutcome> {
  if (buf.byteLength > MAX_PDF_BYTES) {
    return { status: 'unsupported', note: `PDF 超过 ${Math.round(MAX_PDF_BYTES / 1024 / 1024)}MB，仅作为附件保留` }
  }
  if (!buf.subarray(0, 1024).toString('latin1').includes('%PDF-')) return { status: 'failed', note: '不是 PDF（缺少 %PDF- 文件头）' }
  if (declaresEncryption(buf)) return { status: 'failed', note: 'PDF 已加密，无法提取正文' }

  let opened: Awaited<ReturnType<typeof openPdfDocument>>
  try {
    opened = await openPdfDocument(buf)
  } catch (error) {
    return { status: 'failed', note: pdfErrorNote(error) }
  }

  try {
    const pages = opened.doc.numPages
    if (!pages) return { status: 'failed', pages, note: 'PDF 里没有页面（文件可能损坏）' }
    const blocks: string[] = []
    let chars = 0
    let truncated = false
    for (let page = 1; page <= pages; page += 1) {
      if (page > MAX_PDF_PAGES || chars >= MAX_PDF_TEXT_CHARS) {
        truncated = true
        break
      }
      const pdfPage = await opened.doc.getPage(page)
      let body = ''
      try {
        const content = await pdfPage.getTextContent()
        body = content.items
          .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : ''))
          .join('')
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .join('\n')
      } finally {
        pdfPage.cleanup()
      }
      if (!body) continue
      const room = MAX_PDF_TEXT_CHARS - chars
      if (body.length >= room) {
        blocks.push(body.slice(0, room))
        chars = MAX_PDF_TEXT_CHARS
        truncated = true
        break
      }
      blocks.push(body)
      chars += body.length
    }

    const text = blocks.join('\n\n').trim()
    if (text.length < MIN_TEXT_CHARS) {
      return { status: 'unsupported', pages, note: 'PDF 里没有可提取的文本层（扫描件或纯图片页），已作为附件保留' }
    }
    const suffix = truncated ? '（页数或正文超出上限，已截断）' : ''
    return { status: 'ok', text, pages, note: `已提取正文：${pages} 页；纯文本，不含排版与图片${suffix}` }
  } catch (error) {
    return { status: 'failed', note: pdfErrorNote(error) }
  } finally {
    await opened.close().catch(() => undefined)
  }
}
