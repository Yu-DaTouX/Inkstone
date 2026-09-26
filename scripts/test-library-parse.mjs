/**
 * 资料解析（实施-25 P03 / T03-4）与服务层（W3）的单测。
 *
 * PDF 用**自造的最小文件**做 fixture，而不是签入二进制样本：
 *   · 未压缩流（老 PDF 常见）与 FlateDecode 流（新 PDF 常见）两条路都要走到；
 *   · 「没有文本层」与「解出来是乱码」必须落到**不同**状态 —— 前者是承诺范围，
 *     后者是数据问题，合成一个会让用户以为格式不支持。
 */

/** 造一个最小 PDF：单页、一个内容流。 */
export function makePdf(text, options = {}) {
  const LF = String.fromCharCode(10)
  const content = 'BT /F1 12 Tf 72 720 Td (' + text + ') Tj ET'
  if (options.noStream) {
    return Buffer.from(['%PDF-1.4', '1 0 obj << /Type /Catalog >> endobj', 'trailer << /Root 1 0 R >>', '%%EOF', ''].join(LF), 'latin1')
  }
  const plain = Buffer.from(content, 'latin1')
  const body = options.compress ? deflate(plain) : plain
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

let deflateFn = null
function deflate(input) {
  if (!deflateFn) throw new Error('zlib 未加载')
  return deflateFn(input)
}

export async function runLibraryParserTests(ok, parser, helpers) {
  const { mkdtemp, writeFile, rm } = helpers
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { deflateSync } = await import('node:zlib')
  deflateFn = deflateSync

  ok(typeof parser.parseLibraryFile === 'function', '解析器入口存在')

  /* ---- HTML 正文 ---- */
  {
    const html = '<html><head><title>标题 A</title><style>p{color:red}</style></head><body><script>var x=1</script><h1>大标题</h1><p>第一段</p><p>第二段 &amp; 实体 &#65;</p></body></html>'
    const out = parser.extractHtmlText(html)
    ok(out.title === '标题 A', 'HTML：取到 title', String(out.title))
    ok(!out.text.includes('var x=1'), 'HTML：去掉 script')
    ok(!out.text.includes('color:red'), 'HTML：去掉 style')
    ok(out.text.includes('大标题') && out.text.includes('第一段') && out.text.includes('第二段'), 'HTML：保留正文')
    ok(out.text.includes('&') && out.text.includes('A'), 'HTML：解实体（含数字实体）', out.text.replace(/\n/g, '|'))
    ok(out.text.split('\n').length >= 3, 'HTML：块级标签产生换行')
  }

  /* ---- PDF 字符串解码 ---- */
  {
    const bs = String.fromCharCode(92)
    ok(parser.decodePdfString(`a${bs}n b`) === 'a\n b', 'PDF 字符串：换行转义')
    ok(parser.decodePdfString(`x${bs}(y${bs})`) === 'x(y)', 'PDF 字符串：括号转义')
    ok(parser.decodePdfString(`q${bs}101`) === 'qA', 'PDF 字符串：八进制转义（101 = A）', parser.decodePdfString(`q${bs}101`))
    const bom = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('汉字', 'utf16le').swap16()])
    ok(parser.decodePdfString(bom.toString('latin1')) === '汉字', 'PDF 字符串：UTF-16BE（带 BOM）')
  }

  /* ---- 内容流提取 ---- */
  {
    const text = parser.extractPdfText('BT /F1 12 Tf 72 720 Td (Hello) Tj 72 700 Td (World) Tj ET')
    ok(text.includes('Hello') && text.includes('World'), '内容流：取出两段文本')
    ok(text.includes('\n'), '内容流：Td 产生换行', JSON.stringify(text))
    const joined = parser.extractPdfText('[(He) -20 (llo)] TJ')
    ok(joined.includes('Hello'), '内容流：TJ 数组内拼接不插空格', JSON.stringify(joined))
  }

  /* ---- 可打印比例 ---- */
  {
    ok(parser.printableRatio('正常的中文 English 123！') > 0.9, '可打印比例：正常文本接近 1')
    ok(parser.printableRatio(String.fromCharCode(1, 2, 3, 4, 5)) < 0.2, '可打印比例：控制字符很低')
    ok(parser.printableRatio('') === 0, '可打印比例：空串为 0')
  }

  /* ---- 文件解析：文本 / 附件 / PDF 各档 ---- */
  const root = await mkdtemp(join(tmpdir(), 'yan-libparse-'))
  try {
    const write = async (name, data) => {
      const full = join(root, name)
      await writeFile(full, data)
      return full
    }

    const txt = await write('note.txt', '第一行\n第二行')
    const md = await write('readme.md', '# 标题\n\n正文')
    const png = await write('pic.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const docx = await write('doc.docx', Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    const unknown = await write('data.xyz', 'some content here')
    const empty = await write('empty.txt', '   \n  ')
    const html = await write('page.html', '<html><body><p>网页正文</p></body></html>')
    const pdfPlain = await write('plain.pdf', makePdf('Hello Yan Library from Inkstone'))
    const pdfZip = await write('zip.pdf', makePdf('Compressed Yan Library content here', { compress: true }))
    const pdfNoStream = await write('nostream.pdf', makePdf('', { noStream: true }))
    const notPdf = await write('fake.pdf', 'this is not a pdf at all, just text')

    const plain = await parser.parseLibraryFile(txt, 'file')
    ok(plain.status === 'ok' && plain.text.includes('第一行'), 'txt → 可阅读')
    const mdOut = await parser.parseLibraryFile(md, 'file')
    ok(mdOut.status === 'ok' && mdOut.text.includes('# 标题'), 'md → 可阅读')
    const htmlOut = await parser.parseLibraryFile(html, 'file')
    ok(htmlOut.status === 'ok' && htmlOut.text.includes('网页正文') && !htmlOut.text.includes('<p>'), 'html → 去标签后可阅读')
    ok((await parser.parseLibraryFile(png, 'file')).status === 'unsupported', 'png → 仅附件（未接 OCR）')
    ok((await parser.parseLibraryFile(docx, 'file')).status === 'unsupported', 'docx → 仅附件（未接 Office）')
    ok((await parser.parseLibraryFile(unknown, 'file')).status === 'unsupported', '未知扩展名 → 不当文本读，标仅附件')
    ok((await parser.parseLibraryFile(empty, 'file')).status === 'unsupported', '空文件 → 明确说明')

    const plainPdf = await parser.parseLibraryFile(pdfPlain, 'file')
    ok(plainPdf.status === 'ok' && plainPdf.text?.includes('Hello Yan Library'), 'PDF（未压缩流）→ 提取到正文', plainPdf.note)
    ok(plainPdf.pages === 1, 'PDF：页数统计', String(plainPdf.pages))
    const zipPdf = await parser.parseLibraryFile(pdfZip, 'file')
    ok(zipPdf.status === 'ok' && zipPdf.text?.includes('Compressed Yan Library'), 'PDF（FlateDecode）→ 提取到正文', zipPdf.note)
    ok((await parser.parseLibraryFile(pdfNoStream, 'file')).status === 'failed', 'PDF 无内容流 → failed（不是 unsupported）')
    ok((await parser.parseLibraryFile(notPdf, 'file')).status === 'failed', '扩展名是 pdf 但不是 PDF → failed')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

export async function runLibraryServiceTests(ok, mod, helpers) {
  const { LibraryService, resolveWithin } = mod
  const { mkdtemp, writeFile, stat, rm } = helpers
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  /* ---- 路径逃逸：正文路径是我们写的，读取也要守住 ---- */
  {
    const root = join(tmpdir(), 'yan-lib-root')
    ok(resolveWithin(root, 'library/text/a.txt') !== null, '允许 root 内的相对路径')
    ok(resolveWithin(root, '../outside.txt') === null, '拒绝越界路径（../）')
    ok(resolveWithin(root, 'library/../../escape.txt') === null, '拒绝多处越界')
  }

  const root = await mkdtemp(join(tmpdir(), 'yan-libsvc-'))
  try {
    const service = new LibraryService({ root })
    const doc = join(root, 'paper.md')
    await writeFile(doc, '第一版内容：光速与折射\n\n更多细节')

    const first = await service.import({
      kind: 'file',
      ref: doc,
      title: '论文',
      owner: { kind: 'session', id: 'sess-a' }
    })
    ok(first.ok === true && first.decision === 'new-source' && first.version === 1, '导入新资料')
    ok(first.parse?.status === 'ok' && !!first.parse.textPath, '解析成功并记录文本路径', JSON.stringify(first.parse))
    {
      const info = await stat(join(root, first.parse.textPath))
      ok(info.isFile() && info.size > 0, '**解析文本真的落盘，且文件名带版本号**')
    }
    const sourceId = first.sourceId
    const ref1 = { sourceId, version: 1 }
    const open1 = await service.openRef(ref1)
    ok(open1.outcome === 'ok' && (open1.text ?? '').includes('第一版内容'), '按引用读到正文')
    ok(open1.source?.title === '论文', '引用能带出资料标题')

    const again = await service.import({ kind: 'file', ref: doc, title: '论文' })
    ok(again.decision === 'unchanged' && again.version === 1, '重复导入幂等（不产生第二版）')
    ok(service.store.document().versions.length === 1, '幂等导入后版本数仍是 1')

    /* ---- 验收核心：改了文件，旧引用仍打开旧版本 ---- */
    await writeFile(doc, '第二版内容：完全不同的段落，长度也不同')
    const second = await service.import({ kind: 'file', ref: doc, title: '论文' })
    ok(second.decision === 'new-version' && second.version === 2, '内容变化 → 推进到第 2 版')
    const openOld = await service.openRef(ref1)
    ok(openOld.outcome === 'ok' && (openOld.text ?? '').includes('第一版内容'), '**旧引用仍读到第一版正文**', (openOld.text ?? '').slice(0, 16))
    const openNew = await service.openRef({ sourceId, version: 2 })
    ok((openNew.text ?? '').includes('第二版内容'), '新引用读到第二版正文')
    ok(openOld.version?.fingerprint !== openNew.version?.fingerprint, '两版指纹不同（确实换过内容）')
    ok(service.store.document().refs.length === 1, '导入时登记的引用只有一条', String(service.store.document().refs.length))

    const missing = await service.openRef({ sourceId, version: 99 })
    ok(missing.outcome === 'missing' && missing.text === undefined, '指向不存在版本的引用 → missing，不抛错')

    /* ---- 旧引用提升（T03-3）：用到才建，重复不重复建档 ---- */
    const promote1 = await service.promoteLegacy({ sessionId: 'sess-legacy', legacyId: 'src-old-1', kind: 'file', title: '老资料', ref: doc })
    const promote2 = await service.promoteLegacy({ sessionId: 'sess-legacy', legacyId: 'src-old-1', kind: 'file', title: '老资料', ref: doc })
    ok(promote1.ok === true && promote1.mapped === true, '旧会话引用首次提升会建档并建映射')
    ok(promote2.sourceId === promote1.sourceId && promote2.decision === 'unchanged', '第二次提升命中已有映射（不重复建档）')
    ok(service.store.document().legacy.length === 1, '映射表只有一条')

    /* ---- 软移除：旧引用仍能打开 ---- */
    await service.store.removeSource(sourceId)
    const removed = await service.openRef(ref1)
    ok(removed.outcome === 'removed', '移除后判定为 removed')
    ok((removed.text ?? '').includes('第一版内容'), '**移除后旧引用仍能打开旧版本**（T03-6）')

    /* ---- 原件被删：如实标记，不静默消失 ---- */
    await rm(doc)
    const verified = await service.verifyAvailability([ref1, { sourceId, version: 2 }])
    ok(verified.checked === 2 && verified.unavailable === 2, '原件删除后复核出两条不可用', JSON.stringify(verified))
    const unavailable = await service.openRef(ref1)
    ok(unavailable.outcome === 'unavailable', '原件不可用优先于 removed 上报', unavailable.outcome)

    /* ---- 原件没了就不该再建新资料 ---- */
    const failed = await service.import({ kind: 'file', ref: doc, title: '不存在的文件' })
    ok(failed.ok === false && !!failed.error, '导入已删除的文件如实失败（不建空资料）', failed.error)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
