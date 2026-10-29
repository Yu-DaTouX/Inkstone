import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const root = new URL('../src/', import.meta.url)

async function load(rel) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(rel, root))],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent'
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

const extract = await load('main/office/extract.ts')
const shared = await load('shared/office.ts')
const notebook = await load('renderer/src/features/preview/notebook.ts')

let passed = 0
const check = (name, fn) => {
  fn()
  passed += 1
  process.stdout.write(`  ✓ ${name}\n`)
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let value = i
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[i] = value >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function zipOf(files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, 'utf8')
    const data = Buffer.from(content, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBytes, data)
    centrals.push(central, nameBytes)
    offset += local.length + nameBytes.length + data.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, directory, end])
}

const DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>概述</w:t></w:r></w:p>
<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>粗体</w:t></w:r><w:r><w:t>与</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>斜体</w:t></w:r></w:p>
<w:p><w:r><w:t>普通段落</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>第一项</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>第二项</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>编号项</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>A2</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B2</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:r><w:t>末尾段落</w:t></w:r></w:p>
</w:body></w:document>`

const NUMBERING_XML = `<?xml version="1.0"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`

function docxBuffer(documentXml = DOCUMENT_XML) {
  return zipOf({ 'word/document.xml': documentXml, 'word/numbering.xml': NUMBERING_XML })
}

check('docx 结构化：标题、粗斜体、列表、表格按文档流输出', () => {
  const view = extract.extractOffice(docxBuffer(), 'docx')
  assert.equal(view.ok, true)
  assert.equal(view.format, 'docx')
  const blocks = view.blocks
  assert.equal(blocks[0].kind, 'heading')
  assert.equal(blocks[0].level, 1)
  assert.equal(blocks[0].text, '概述')
  const paragraph = blocks[1]
  assert.equal(paragraph.kind, 'paragraph')
  assert.deepEqual(
    paragraph.runs.map((run) => [run.text, !!run.bold, !!run.italic]),
    [
      ['粗体', true, false],
      ['与', false, false],
      ['斜体', false, true]
    ]
  )
  assert.equal(blocks[2].kind, 'paragraph')
  assert.equal(blocks[2].runs[0].text, '普通段落')
  assert.equal(blocks[3].kind, 'list')
  assert.equal(blocks[3].ordered, false)
  assert.deepEqual(blocks[3].items, ['第一项', '第二项'])
  assert.equal(blocks[4].kind, 'list')
  assert.equal(blocks[4].ordered, true)
  assert.deepEqual(blocks[4].items, ['编号项'])
  assert.equal(blocks[5].kind, 'table')
  assert.deepEqual(blocks[5].rows, [
    ['A1', 'B1'],
    ['A2', 'B2']
  ])
  assert.equal(blocks[6].runs[0].text, '末尾段落')
  const lines = view.sections[0].lines
  assert.ok(lines.includes('概述'))
  assert.ok(lines.includes('粗体与斜体'))
  assert.ok(lines.includes('A1 | B1'))
  assert.ok(lines.includes('编号项'))
})

check('docx 结构化：没有 numbering.xml 时列表按无序处理，缺 document.xml 报错', () => {
  const noNumbering = extract.extractOffice(zipOf({ 'word/document.xml': DOCUMENT_XML }), 'docx')
  assert.equal(noNumbering.ok, true)
  assert.equal(noNumbering.blocks[3].kind, 'list')
  assert.equal(noNumbering.blocks[3].ordered, false)
  const missing = extract.extractOffice(zipOf({ 'word/styles.xml': '<x/>' }), 'docx')
  assert.equal(missing.ok, false)
  assert.match(missing.error, /document\.xml/)
})

check('docx 结构化：标题层级按 outlineLvl 与 Heading2 识别', () => {
  const xml = `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading 2"/></w:pPr><w:r><w:t>二级</w:t></w:r></w:p>
<w:p><w:pPr><w:outlineLvl w:val="2"/></w:pPr><w:r><w:t>三级</w:t></w:r></w:p>
</w:body></w:document>`
  const view = extract.extractOffice(docxBuffer(xml), 'docx')
  assert.equal(view.ok, true)
  assert.deepEqual(
    view.blocks.map((block) => [block.kind, block.level, block.text]),
    [
      ['heading', 2, '二级'],
      ['heading', 3, '三级']
    ]
  )
})

function workbookFiles(rows) {
  const sheetRows = rows
    .map((cells, rowIndex) => {
      const body = cells
        .map((value, columnIndex) => {
          const ref = `${String.fromCharCode(65 + columnIndex)}${rowIndex + 1}`
          return value === null ? '' : `<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`
        })
        .join('')
      return `<row r="${rowIndex + 1}">${body}</row>`
    })
    .join('')
  return {
    'xl/workbook.xml':
      '<?xml version="1.0"?><workbook><sheets><sheet name="数据" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet><sheetData>${sheetRows}</sheetData></worksheet>`
  }
}

check('xlsx 结构化：行、列、行号起点与空单元格补位', () => {
  const view = extract.extractOffice(
    zipOf(workbookFiles([['名称', '数量'], ['甲', '1'], [null, '2'], ['乙', null]])),
    'xlsx'
  )
  assert.equal(view.ok, true)
  assert.equal(view.sheets.length, 1)
  const sheet = view.sheets[0]
  assert.equal(sheet.name, '数据')
  assert.deepEqual(sheet.rows, [['名称', '数量'], ['甲', '1'], ['', '2'], ['乙', '']])
  assert.equal(sheet.startRow, 1)
  assert.equal(sheet.startColumn, 0)
  assert.equal(sheet.truncated, undefined)
  assert.ok(view.sections[0].lines.includes('A1: 名称'))
})

check('xlsx 结构化：超过 500 行 50 列时截断并标记', () => {
  const rows = Array.from({ length: 620 }, (_, index) => [`r${index + 1}`, `c${index + 1}`])
  const view = extract.extractOffice(zipOf(workbookFiles(rows)), 'xlsx')
  assert.equal(view.ok, true)
  const sheet = view.sheets[0]
  assert.equal(sheet.rows.length, 500)
  assert.equal(sheet.rows[0][0], 'r1')
  assert.equal(sheet.rows[499][0], 'r500')
  assert.equal(sheet.truncated, true)
})

check('xlsx 结构化：行从 C3 开始时保留起始行号与列号', () => {
  const files = workbookFiles([['值']])
  files['xl/worksheets/sheet1.xml'] =
    '<?xml version="1.0"?><worksheet><sheetData><row r="3"><c r="C3" t="inlineStr"><is><t>值</t></is></c></row></sheetData></worksheet>'
  const view = extract.extractOffice(zipOf(files), 'xlsx')
  assert.equal(view.ok, true)
  assert.deepEqual(view.sheets[0].rows, [['值']])
  assert.equal(view.sheets[0].startRow, 3)
  assert.equal(view.sheets[0].startColumn, 2)
  assert.equal(shared.officeColumnName(2), 'C')
  assert.equal(shared.officeColumnName(25), 'Z')
  assert.equal(shared.officeColumnName(26), 'AA')
})

function pptxFiles() {
  return {
    'ppt/slides/slide1.xml': `<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>
<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>封面标题</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>要点一</a:t></a:r></a:p><a:p><a:r><a:t>要点二</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:sld>`,
    'ppt/slides/slide2.xml': `<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>
<p:sp><p:nvSpPr><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>第二页</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:sld>`,
    'ppt/notesSlides/notesSlide1.xml': `<?xml version="1.0"?><p:notes xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>1</a:t></a:r></a:p><a:p><a:r><a:t>讲稿内容</a:t></a:r></a:p></p:notes>`
  }
}

check('pptx 结构化：标题、要点与备注分页', () => {
  const view = extract.extractOffice(zipOf(pptxFiles()), 'pptx')
  assert.equal(view.ok, true)
  assert.equal(view.slides.length, 2)
  assert.equal(view.slides[0].index, 1)
  assert.equal(view.slides[0].title, '封面标题')
  assert.deepEqual(view.slides[0].bullets, ['要点一', '要点二'])
  assert.deepEqual(view.slides[0].notes, ['讲稿内容'])
  assert.equal(view.slides[1].title, '第二页')
  assert.deepEqual(view.slides[1].bullets, [])
  assert.equal(view.slides[1].notes, undefined)
  assert.ok(view.sections[1].lines.includes('第二页'))
})

check('Notebook：markdown、code、raw 单元与执行计数', () => {
  const parsed = notebook.parseNotebook(
    JSON.stringify({
      nbformat: 4,
      metadata: { kernelspec: { language: 'python' }, language_info: { name: 'python' } },
      cells: [
        { cell_type: 'markdown', source: ['# 标题\n', '正文'] },
        { cell_type: 'code', source: 'print(1)', execution_count: 3, outputs: [] },
        { cell_type: 'code', source: 'x = 1', execution_count: null, outputs: [] },
        { cell_type: 'raw', source: 'raw text' }
      ]
    })
  )
  assert.equal(parsed.kind, 'ok')
  assert.equal(parsed.language, 'python')
  assert.deepEqual(
    parsed.cells.map((cell) => cell.kind),
    ['markdown', 'code', 'code', 'raw']
  )
  assert.equal(parsed.cells[0].markdown, '# 标题\n正文')
  assert.equal(parsed.cells[1].executionCount, 3)
  assert.equal(parsed.cells[2].executionCount, null)
  assert.equal(parsed.hiddenCells, 0)
})

check('Notebook：stream、text/plain、image/png 与其他 mime 输出', () => {
  const parsed = notebook.parseNotebook(
    JSON.stringify({
      cells: [
        {
          cell_type: 'code',
          source: 'plot()',
          execution_count: 1,
          outputs: [
            { output_type: 'stream', name: 'stdout', text: ['hello\n', 'world\n'] },
            { output_type: 'execute_result', data: { 'text/plain': '42' } },
            { output_type: 'display_data', data: { 'image/png': 'QUJD\n', 'text/plain': '<Figure>' } },
            { output_type: 'display_data', data: { 'text/html': '<b>x</b>' } },
            { output_type: 'error', ename: 'ValueError', evalue: 'bad', traceback: ['\u001b[0;31mValueError\u001b[0m'] }
          ]
        }
      ]
    })
  )
  assert.equal(parsed.kind, 'ok')
  const outputs = parsed.cells[0].outputs
  assert.deepEqual(outputs[0], { kind: 'text', text: 'hello\nworld\n' })
  assert.deepEqual(outputs[1], { kind: 'text', text: '42' })
  assert.equal(outputs[2].kind, 'image')
  assert.equal(outputs[2].dataUrl, 'data:image/png;base64,QUJD')
  assert.deepEqual(outputs[3], { kind: 'text', text: '<Figure>' })
  assert.deepEqual(outputs[4], { kind: 'mime', mime: 'text/html' })
  assert.equal(outputs[5].kind, 'text')
  assert.ok(outputs[5].text.startsWith('ValueError: bad'))
  assert.ok(!outputs[5].text.includes('\u001b'))
})

check('Notebook：坏 JSON、空文件与非 notebook 结构', () => {
  assert.deepEqual(notebook.parseNotebook('   '), { kind: 'empty' })
  assert.deepEqual(notebook.parseNotebook('{oops'), { kind: 'failed', reason: 'json' })
  assert.deepEqual(notebook.parseNotebook('{"cells": 3}'), { kind: 'failed', reason: 'shape' })
  assert.deepEqual(notebook.parseNotebook('{"nbformat": 3}'), { kind: 'failed', reason: 'shape' })
})

check('Notebook：nbformat 3 的 worksheets 与 pyout 也能读', () => {
  const parsed = notebook.parseNotebook(
    JSON.stringify({
      nbformat: 3,
      worksheets: [
        {
          cells: [
            { cell_type: 'heading', level: 2, source: '旧标题' },
            { cell_type: 'code', input: 'print(2)', language: 'python', outputs: [{ output_type: 'pyout', text: ['2'] }] }
          ]
        }
      ]
    })
  )
  assert.equal(parsed.kind, 'ok')
  assert.equal(parsed.cells[0].markdown, '## 旧标题')
  assert.equal(parsed.cells[1].source, 'print(2)')
  assert.deepEqual(parsed.cells[1].outputs, [{ kind: 'text', text: '2' }])
})

check('Notebook：markdown 去掉图片与链接动作，代码块原样保留', () => {
  const source = [
    '# 标题',
    '看这个 [链接](https://example.com) 和 ![图](https://example.com/a.png)',
    '自动链接 <https://example.com>',
    '[ref]: https://example.com',
    '`[行内](https://example.com)` 保留反引号',
    '```python',
    '[保留](https://example.com)',
    '```'
  ].join('\n')
  const markdown = notebook.notebookMarkdown(source)
  const lines = markdown.split('\n')
  assert.equal(lines[0], '# 标题')
  assert.equal(lines[1], '看这个 链接 和 图')
  assert.equal(lines[2], '自动链接 example.com')
  assert.equal(lines[3], '')
  assert.ok(lines[4].includes('`[行内](https://example.com)`'))
  assert.equal(lines[6], '[保留](https://example.com)')
})

check('Notebook：code cell 用足够长的围栏包住反引号', () => {
  const fenced = notebook.notebookFence('s = """```"""\nprint(s)\n', 'python')
  assert.ok(fenced.startsWith('````python\n'))
  assert.ok(fenced.endsWith('\n````'))
  assert.ok(fenced.includes('s = """```"""'))
  assert.ok(!fenced.includes('\n\n````'))
  assert.ok(notebook.notebookFence('x = 1', 'python').startsWith('```python\n'))
})

process.stdout.write(`\n${passed} 组检查通过\n`)
