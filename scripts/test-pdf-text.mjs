import { deflateSync } from 'node:zlib'

function pdfObjects(pages, compress) {
  const LF = String.fromCharCode(10)
  const escape = (value) => value.replace(/([\\()])/g, '\\$1')
  const contentOf = (lines) => {
    const body = lines
      .map((line, index) => (index === 0 ? `(${escape(line)}) Tj` : `0 -16 Td (${escape(line)}) Tj`))
      .join(LF)
    return `BT /F1 12 Tf 72 720 Td ${body} ET`
  }
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>']
  const kids = pages.map((_, index) => `${3 + index * 2} 0 R`).join(' ')
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`)
  pages.forEach((lines, index) => {
    const pageId = 3 + index * 2
    const contentId = pageId + 1
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${3 + pages.length * 2} 0 R >> >> /Contents ${contentId} 0 R >>`
    )
    const raw = Buffer.from(contentOf(lines), 'latin1')
    const stream = compress ? deflateSync(raw) : raw
    const filter = compress ? ' /Filter /FlateDecode' : ''
    objects.push({ stream, head: `<< /Length ${stream.length}${filter} >>` })
  })
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  return { objects, LF }
}

export function makePdf(pages, options = {}) {
  const list = Array.isArray(pages) ? pages : [[pages]]
  const { objects, LF } = pdfObjects(list, options.compress === true)
  const parts = ['%PDF-1.5']
  objects.forEach((object, index) => {
    parts.push(`${index + 1} 0 obj`)
    if (typeof object === 'string') parts.push(object, 'endobj')
    else parts.push(object.head, 'stream', object.stream, 'endstream', 'endobj')
  })
  parts.push('trailer << /Root 1 0 R >>', '%%EOF', '')
  const chunks = []
  for (const part of parts) chunks.push(typeof part === 'string' ? Buffer.from(part + LF, 'latin1') : Buffer.concat([part, Buffer.from(LF, 'latin1')]))
  return Buffer.concat(chunks)
}

export function runPdfTextTests(ok, pdf) {
  return (async () => {
    ok(pdf.MAX_PDF_BYTES > 0 && pdf.MAX_PDF_PAGES > 0 && pdf.MAX_PDF_TEXT_CHARS > 0, 'PDF 预算常量已导出')

    const plain = await pdf.parsePdfBuffer(makePdf('Hello Yan Library from Inkstone'))
    ok(plain.status === 'ok' && plain.text?.includes('Hello Yan Library'), 'PDF（未压缩流）→ 提取到正文', plain.note)
    ok(plain.pages === 1, 'PDF：页数统计', String(plain.pages))
    ok(/已提取正文：1 页/.test(plain.note), 'PDF：note 带上页数', plain.note)

    const zipped = await pdf.parsePdfBuffer(makePdf('Compressed Yan Library content here', { compress: true }))
    ok(zipped.status === 'ok' && zipped.text?.includes('Compressed Yan Library'), 'PDF（FlateDecode）→ 提取到正文', zipped.note)

    const twoPages = await pdf.parsePdfBuffer(makePdf([['第一页内容 First page text'], ['第二页内容 Second page text']]))
    ok(twoPages.status === 'ok' && twoPages.pages === 2, 'PDF：两页文档按页统计', String(twoPages.pages))
    ok(twoPages.text?.includes('First page') && twoPages.text?.includes('Second page'), 'PDF：两页正文都在', twoPages.text)
    ok(twoPages.text?.indexOf('First page') < twoPages.text?.indexOf('Second page'), 'PDF：正文按页顺序拼接')

    const notPdf = await pdf.parsePdfBuffer(Buffer.from('this is not a pdf at all, just text'))
    ok(notPdf.status === 'failed' && /不是 PDF/.test(notPdf.note), '不是 PDF → failed', notPdf.note)

    const broken = await pdf.parsePdfBuffer(Buffer.from('%PDF-1.5\nthis body is garbage\n%%EOF\n', 'latin1'))
    ok(broken.status === 'failed', 'PDF 头正确但结构损坏 → failed', broken.note)

    const encrypted = await pdf.parsePdfBuffer(Buffer.concat([makePdf('secret'), Buffer.from('\ntrailer << /Encrypt 9 0 R >>\n', 'latin1')]))
    ok(encrypted.status === 'failed' && /已加密/.test(encrypted.note), '含 /Encrypt 的 PDF → failed 并说明已加密', encrypted.note)

    const blank = await pdf.parsePdfBuffer(makePdf([['']]))
    ok(blank.status !== 'ok', '没有文本层的 PDF 不返回 ok', blank.status)

    const oversize = Buffer.alloc(pdf.MAX_PDF_BYTES + 1)
    const tooBig = await pdf.parsePdfBuffer(oversize)
    ok(tooBig.status === 'unsupported' && /64MB/.test(tooBig.note), '超过体积上限 → unsupported', tooBig.note)
  })()
}
