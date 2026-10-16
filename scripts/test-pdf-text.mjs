import { deflateSync } from 'node:zlib'

export function makePdf(text, options = {}) {
  const LF = String.fromCharCode(10)
  const content = 'BT /F1 12 Tf 72 720 Td (' + text + ') Tj ET'
  if (options.noStream) {
    return Buffer.from(['%PDF-1.4', '1 0 obj << /Type /Catalog >> endobj', 'trailer << /Root 1 0 R >>', '%%EOF', ''].join(LF), 'latin1')
  }
  const plain = Buffer.from(content, 'latin1')
  const body = options.compress ? deflateSync(plain) : plain
  const filter = options.compress ? ' /Filter /FlateDecode' : ''
  const head = [
    '%PDF-1.4',
    '1 0 obj << /Type /Catalog >> endobj',
    '2 0 obj << /Type /Page /Contents 3 0 R >> endobj',
    '3 0 obj << /Length ' + body.length + filter + ' >>',
    'stream',
    ''
  ].join(LF)
  const tail = ['', 'endstream', 'endobj', 'trailer << /Root 1 0 R >>', '%%EOF', ''].join(LF)
  return Buffer.concat([Buffer.from(head, 'latin1'), body, Buffer.from(tail, 'latin1')])
}

export function runPdfTextTests(ok, pdf) {
  {
    const bs = String.fromCharCode(92)
    ok(pdf.decodePdfString(`a${bs}n b`) === 'a\n b', 'PDF 字符串：换行转义')
    ok(pdf.decodePdfString(`x${bs}(y${bs})`) === 'x(y)', 'PDF 字符串：括号转义')
    ok(pdf.decodePdfString(`q${bs}101`) === 'qA', 'PDF 字符串：八进制转义（101 = A）', pdf.decodePdfString(`q${bs}101`))
    const bom = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('汉字', 'utf16le').swap16()])
    ok(pdf.decodePdfString(bom.toString('latin1')) === '汉字', 'PDF 字符串：UTF-16BE（带 BOM）')
  }

  {
    const text = pdf.extractPdfText('BT /F1 12 Tf 72 720 Td (Hello) Tj 72 700 Td (World) Tj ET')
    ok(text.includes('Hello') && text.includes('World'), '内容流：取出两段文本')
    ok(text.includes('\n'), '内容流：Td 产生换行', JSON.stringify(text))
    const joined = pdf.extractPdfText('[(He) -20 (llo)] TJ')
    ok(joined.includes('Hello'), '内容流：TJ 数组内拼接不插空格', JSON.stringify(joined))
  }

  {
    ok(pdf.printableRatio('正常的中文 English 123！') > 0.9, '可打印比例：正常文本接近 1')
    ok(pdf.printableRatio(String.fromCharCode(1, 2, 3, 4, 5)) < 0.2, '可打印比例：控制字符很低')
    ok(pdf.printableRatio('') === 0, '可打印比例：空串为 0')
  }

  const plain = pdf.parsePdfBuffer(makePdf('Hello Yan Library from Inkstone'))
  ok(plain.status === 'ok' && plain.text?.includes('Hello Yan Library'), 'PDF（未压缩流）→ 提取到正文', plain.note)
  ok(plain.pages === 1, 'PDF：页数统计', String(plain.pages))
  const zipped = pdf.parsePdfBuffer(makePdf('Compressed Yan Library content here', { compress: true }))
  ok(zipped.status === 'ok' && zipped.text?.includes('Compressed Yan Library'), 'PDF（FlateDecode）→ 提取到正文', zipped.note)
  ok(pdf.parsePdfBuffer(makePdf('', { noStream: true })).status === 'failed', 'PDF 无内容流 → failed（不是 unsupported）')
  ok(pdf.parsePdfBuffer(Buffer.from('this is not a pdf at all, just text')).status === 'failed', '不是 PDF → failed')
  ok(
    pdf.MAX_PDF_STREAM_BYTES > 0 && pdf.MAX_PDF_TOTAL_BYTES >= pdf.MAX_PDF_STREAM_BYTES,
    '解压预算常量已导出（单流 ≤ 累计）'
  )
  const bomb = pdf.parsePdfBuffer(makePdf(' '.repeat(20 * 1024 * 1024) + 'BT (ONLY_SYNTHETIC_OVERSIZE) Tj ET', { compress: true }))
  ok(bomb.status === 'failed', '解压超出上限的内容流被跳过（不返回 ok）', bomb.status)
  ok(/内容流超出预算或解压失败/.test(bomb.note), 'note 说明是超出解压上限，而不是把压缩数据当未压缩流乱解', bomb.note)
}
