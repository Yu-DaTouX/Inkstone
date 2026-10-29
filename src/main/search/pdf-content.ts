import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ReadPageError } from './page-types'

export async function openPdfDocument(data: Uint8Array, signal?: AbortSignal) {
  const { getDocument, GlobalWorkerOptions } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  signal?.throwIfAborted()
  const packageDir = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
  GlobalWorkerOptions.workerSrc = pathToFileURL(join(packageDir, 'legacy', 'build', 'pdf.worker.mjs')).href
  const task = getDocument({ data: new Uint8Array(data), useSystemFonts: false, disableFontFace: true, useWorkerFetch: false, standardFontDataUrl: join(packageDir, 'standard_fonts') + '/' })
  const cancel = (): void => { void task.destroy().catch(() => undefined) }
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    const doc = await task.promise
    return {
      doc,
      close: async (): Promise<void> => {
        signal?.removeEventListener('abort', cancel)
        await task.destroy()
      }
    }
  } catch (error) {
    signal?.removeEventListener('abort', cancel)
    await task.destroy().catch(() => undefined)
    throw error
  }
}

export async function extractPdf(data: Uint8Array, signal: AbortSignal, maxChars: number) {
  const { doc, close } = await openPdfDocument(data, signal)
  try {
    let title = ''
    try {
      const meta = await doc.getMetadata()
      const info = meta.info as { Title?: unknown }
      if (typeof info.Title === 'string') title = info.Title
    } catch { }
    let text = ''
    const links: Array<{ title: string; url: string }> = []
    const pages: Array<{ page: number; offset: number; endOffset: number }> = []
    for (let page = 1; page <= Math.min(doc.numPages, 200) && text.length < maxChars; page++) {
      signal.throwIfAborted()
      const pdfPage = await doc.getPage(page)
      const content = await pdfPage.getTextContent()
      const annotations = await pdfPage.getAnnotations()
      for (const annotation of annotations) {
        if (typeof annotation.url !== 'string' || links.length >= 500) continue
        try {
          const url = new URL(annotation.url)
          if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) links.push({ title: `Page ${page}`, url: url.href })
        } catch { }
      }
      const body = content.items.map((item) => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').trim()
      const offset = text.length
      text += `\n\n## Page ${page}\n\n${body}`
      pages.push({ page, offset, endOffset: text.length })
      pdfPage.cleanup()
    }
    if (!text.replace(/## Page \d+/g, '').trim()) throw new ReadPageError('pdf_no_text', 'PDF 没有可提取的文字，可能需要 OCR')
    return { title, text: text.slice(0, maxChars), pages, links, pageCount: doc.numPages, truncated: text.length > maxChars || pages.length < doc.numPages, totalChars: text.length }
  } finally {
    await close()
  }
}
