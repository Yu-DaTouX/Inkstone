import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const root = new URL('../src/renderer/src/', import.meta.url)

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

const format = await load('features/preview/preview-format.ts')
const csv = await load('features/preview/csv-table.ts')

let passed = 0
const check = (name, fn) => {
  fn()
  passed += 1
  process.stdout.write(`  ✓ ${name}\n`)
}

check('六类格式都按扩展名识别，HTML 默认先看源码', () => {
  assert.equal(format.previewFormatOf('a.csv'), 'csv')
  assert.equal(format.previewFormatOf('a.TSV'), 'csv')
  assert.equal(format.previewFormatOf('a.html'), 'html')
  assert.equal(format.previewFormatOf('a.htm'), 'html')
  assert.equal(format.previewFormatOf('a.svg'), 'svg')
  assert.equal(format.previewFormatOf('a.PDF'), 'pdf')
  assert.equal(format.previewFormatOf('a.png'), 'image')
  assert.equal(format.previewFormatOf('a.avif'), 'image')
  assert.equal(format.previewFormatOf('a.mp4'), 'video')
  assert.equal(format.previewFormatOf('a.ogg'), 'audio')
  assert.equal(format.previewFormatOf('a.md'), 'markdown')
  assert.equal(format.previewFormatOf('a.txt'), null)
  assert.equal(format.previewFormatOf('a.mkv'), null)
  assert.equal(format.previewFormatIsMedia('pdf'), true)
  assert.equal(format.previewFormatIsMedia('csv'), false)
  assert.equal(format.previewFormatUsesText('csv'), true)
  assert.equal(format.previewFormatUsesText('pdf'), false)
  assert.equal(format.previewFormatOpensAsSource('html'), true)
  assert.equal(format.previewFormatOpensAsSource('svg'), false)
})

check('TSV 用制表符，其余 CSV 用逗号', () => {
  assert.equal(format.csvDelimiterOf('a.tsv'), '\t')
  assert.equal(format.csvDelimiterOf('a.csv'), ',')
})

check('表头、行、单元格的基本解析', () => {
  const result = csv.parseCsvPreview('name,count\na,1\nb,2\n', ',')
  assert.equal(result.kind, 'ok')
  assert.deepEqual(result.table.rows, [['name', 'count'], ['a', '1'], ['b', '2']])
  assert.equal(result.table.hasHeader, true)
  assert.equal(result.table.rowsTruncated, false)
  assert.equal(result.table.colsTruncated, false)
})

check('引号内的换行与转义引号保留', () => {
  const result = csv.parseCsvPreview('name,count\n"a\nb",1\n"x""y",2\n', ',')
  assert.deepEqual(result.table.rows, [['name', 'count'], ['a\nb', '1'], ['x"y', '2']])
})

check('未闭合的引号丢掉最后一条记录并标记截断', () => {
  const result = csv.parseCsvPreview('name,count\nfirst,1\n"unfinished', ',')
  assert.deepEqual(result.table.rows, [['name', 'count'], ['first', '1']])
  assert.equal(result.table.rowsTruncated, true)
  assert.equal(csv.parseCsvPreview('"unfinished', ',').kind, 'failed')
})

check('空单元格与被截短的单元格', () => {
  const cell = csv.parseCsvPreview('a'.repeat(299) + '😀z,1', ',').table
  assert.equal(cell.rows[0][0], 'a'.repeat(299) + '…')
  assert.equal(cell.cellsTruncated, true)
  assert.deepEqual(csv.parseCsvPreview('\n\n', ','), { kind: 'empty' })
  assert.equal(csv.parseCsvPreview('', ',').kind, 'empty')
})

check('行上限 500、列上限 64，超限标记截断', () => {
  const many = ['h', ...Array.from({ length: 600 }, (_, i) => String(i))].join('\n')
  const rows = csv.parseCsvPreview(many, ',')
  assert.equal(rows.table.rows.length, 500)
  assert.equal(rows.table.rowsTruncated, true)
  const wide = `${Array.from({ length: 70 }, (_, i) => `c${i}`).join(',')}\n${Array.from({ length: 70 }, () => 'x').join(',')}`
  const cols = csv.parseCsvPreview(wide, ',')
  assert.equal(cols.table.rows[0].length, 64)
  assert.equal(cols.table.colsTruncated, true)
})

check('超过 1 MiB 时在最后一条完整记录后截断', () => {
  const line = `${'x'.repeat(90)},1\n`
  const big = line.repeat(Math.ceil((1024 * 1024) / line.length) + 40)
  const result = csv.parseCsvPreview(big, ',')
  assert.equal(result.kind, 'ok')
  assert.equal(result.table.rowsTruncated, true)
  assert.ok(result.table.rows.length <= 500)
  for (const row of result.table.rows) assert.equal(row[1], '1')
})

check('表头判定要求首行多为标签、次行出现数字', () => {
  const head = csv.parseCsvPreview('name,count\na,1\n', ',')
  assert.equal(head.table.hasHeader, true)
  const numbers = csv.parseCsvPreview('1,2\n3,4\n', ',')
  assert.equal(numbers.table.hasHeader, false)
})

check('金额与百分比的数字识别', () => {
  for (const [input, expected] of [
    ['1,234.50', 1234.5],
    ['1.234,50', 1234.5],
    ['1.234.567', 1234567],
    ['($2,000)', -2000],
    ['1.5k', 1500],
    ['12%', 12]
  ]) {
    assert.equal(csv.parseCsvNumber(input), expected, input)
  }
  for (const input of ['1.2.3', '192.168.1.1', '1,23,456', 'text']) assert.ok(Number.isNaN(csv.parseCsvNumber(input)), input)
})

check('空值判定与数值列识别', () => {
  for (const input of ['', '-', '–', '—', 'n/a', 'NULL', 'NaN', 'none']) assert.equal(csv.isBlankCsvCell(input), true, input)
  const rows = [
    ['12', '1.2.3', '192.168.1.1', 'none'],
    ['—', '1.2.4', '10.0.0.1', 'NULL'],
    ['1.234.567', '-', 'N/A', '']
  ]
  assert.deepEqual([...csv.numericCsvColumns(rows)], [0])
  assert.equal(csv.csvColumnKind(rows, 0), 'number')
  assert.equal(csv.csvColumnKind(rows, 1), 'text')
  assert.equal(csv.csvColumnKind(rows, 3), 'text')
})

check('排序：稳定、按数值、空值始终在后', () => {
  const rows = [['$10'], ['—'], ['$2'], ['$2'], ['none'], ['($5)']]
  assert.deepEqual(csv.sortCsvRowOrder(rows, { column: 0, direction: 'asc' }, 'number', 'en'), [5, 2, 3, 0, 1, 4])
  assert.deepEqual(csv.sortCsvRowOrder(rows, { column: 0, direction: 'desc' }, 'number', 'en'), [0, 2, 3, 5, 1, 4])
  assert.deepEqual(csv.sortCsvRowOrder([['file10'], ['File2'], ['file2'], ['']], { column: 0, direction: 'asc' }, 'text', 'en'), [1, 2, 0, 3])
  const dates = [['2026-10-15'], ['Oct 1st, 2026'], ['—'], ['2026-10-02']]
  assert.equal(csv.csvColumnKind(dates, 0), 'date')
  assert.deepEqual(csv.sortCsvRowOrder(dates, { column: 0, direction: 'asc' }, 'date', 'en'), [1, 3, 0, 2])
})

check('筛选保留当前排序、全列不区分大小写', () => {
  const rows = [['Alpha', '9'], ['Beta', '2'], ['ALPHA', '1'], ['gamma', '3']]
  const sorted = csv.sortCsvRowOrder(rows, { column: 1, direction: 'asc' }, 'number', 'en')
  assert.deepEqual(csv.filterCsvRowOrder(rows, sorted, 'alpha'), [2, 0])
  assert.deepEqual(csv.filterCsvRowOrder(rows, sorted, '2'), [1])
  assert.deepEqual(csv.filterCsvRowOrder(rows, sorted, 'absent'), [])
  assert.deepEqual(csv.filterCsvRowOrder(rows, sorted, '  '), sorted)
})

check('分号表按分号嗅探，TSV 不走嗅探', () => {
  const semi = csv.parseCsvPreview('a;b\n1;2\n', ',')
  assert.deepEqual(semi.table.rows, [['a', 'b'], ['1', '2']])
  const tsv = csv.parseCsvPreview('a\tb\n1\t2\n', '\t')
  assert.deepEqual(tsv.table.rows, [['a', 'b'], ['1', '2']])
})

console.log(`预览格式：格式分派 / CSV 与 TSV 表格（${passed} 项）检查通过`)
