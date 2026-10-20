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

const view = await load('features/preview/pdf-view.ts')
const find = await load('features/preview/pdf-find.ts')

let passed = 0
const check = (name, fn) => {
  fn()
  passed += 1
  process.stdout.write(`  ✓ ${name}\n`)
}

check('缩放按档位逐级走，端点夹住', () => {
  assert.equal(view.PDF_ZOOM_STEPS.length, 15)
  assert.equal(view.pdfZoomStep(1, 1), 1.1)
  assert.equal(view.pdfZoomStep(1, -1), 0.9)
  assert.equal(view.pdfZoomStep(0.67, 1), 0.75)
  assert.equal(view.pdfZoomStep(1.05, 1), 1.1)
  assert.equal(view.pdfZoomStep(1.05, -1), 1)
  assert.equal(view.pdfZoomStep(4, 1), 4)
  assert.equal(view.pdfZoomStep(0.5, -1), 0.25)
  assert.equal(view.pdfZoomStep(0.1, -1), 0.1)
  assert.equal(view.pdfZoomStep(Number.NaN, 1), 1.1)
  assert.equal(view.pdfClampZoom(99), 4)
  assert.equal(view.pdfClampZoom(0.01), 0.1)
})

check('适合宽度按容器宽度换算并夹在缩放范围内', () => {
  assert.equal(view.pdfFitWidthScale(640, 612), 640 / 612)
  assert.equal(view.pdfFitWidthScale(0, 612), 1)
  assert.equal(view.pdfFitWidthScale(640, 0), 1)
  assert.equal(view.pdfFitWidthScale(100000, 100), 4)
  assert.equal(view.pdfFitWidthScale(10, 10000), 0.1)
})

check('页顶按高度与间距累加，带顶部留白', () => {
  assert.deepEqual(view.pdfPageTops([500, 300], 16, 24), [24, 540])
  assert.deepEqual(view.pdfPageTops([], 16, 24), [])
  assert.deepEqual(view.pdfPageTops([0, 100], 0, 0), [0, 0])
})

check('懒加载窗口包含视口与上下余量', () => {
  const heights = [500, 500, 500]
  const tops = view.pdfPageTops(heights, 16, 0)
  assert.deepEqual(view.pdfPageWindow(tops, heights, 0, 600, 100), { first: 0, last: 1 })
  assert.deepEqual(view.pdfPageWindow(tops, heights, 1000, 600, 100), { first: 1, last: 2 })
  assert.deepEqual(view.pdfPageWindow(tops, heights, 900, 600, 0), { first: 1, last: 2 })
  assert.deepEqual(view.pdfPageWindow([], [], 0, 600, 100), { first: 0, last: -1 })
  assert.deepEqual(view.pdfPageWindow(tops, heights, -50, 0, 0), { first: 0, last: 0 })
})

check('当前页按滚动位置取最后一个已开始的页', () => {
  const tops = [0, 508, 1016]
  assert.equal(view.pdfCurrentPage(tops, 0), 0)
  assert.equal(view.pdfCurrentPage(tops, 400), 0)
  assert.equal(view.pdfCurrentPage(tops, 900), 1)
  assert.equal(view.pdfCurrentPage(tops, 2000), 2)
  assert.equal(view.pdfCurrentPage([], 100), 0)
  const padded = view.pdfPageTops([400, 400], 16, 24)
  assert.equal(view.pdfCurrentPage(padded, 440), 1)
})

check('未知页高度先按首页比例折算', () => {
  assert.deepEqual(view.pdfScaledHeights([{ width: 600, height: 800 }], 3, 0.5), [400, 400, 400])
  assert.deepEqual(
    view.pdfScaledHeights([{ width: 600, height: 800 }, { width: 600, height: 400 }], 2, 1),
    [800, 400]
  )
})

check('文本项按 hasEOL 分行，跨项拼接不插空格', () => {
  assert.deepEqual(find.pdfTextLines([{ str: 'Hello' }, { str: ' world', hasEOL: true }, { str: 'next' }]), [
    'Hello world',
    'next'
  ])
  assert.deepEqual(find.pdfTextLines([{ str: 'a', hasEOL: true }, { str: '', hasEOL: true }]), ['a', ''])
  assert.deepEqual(find.pdfTextLines([]), [])
})

check('查找跨页产出页码与行号，支持正则与大小写', () => {
  const pages = [
    ['Alpha beta', 'gamma'],
    ['delta ALPHA', 'ALPHA alpha']
  ]
  const plain = find.pdfFindMatches(pages, 'alpha', { matchCase: false, wholeWord: false, regexp: false })
  assert.equal(plain.matches.length, 4)
  assert.deepEqual(
    plain.matches.map((match) => match.page),
    [0, 1, 1, 1]
  )
  assert.equal(plain.matches[0].line, 0)
  assert.deepEqual(
    { start: plain.matches[3].start, end: plain.matches[3].end },
    { start: 6, end: 11 }
  )
  const cased = find.pdfFindMatches(pages, 'ALPHA', { matchCase: true, wholeWord: false, regexp: false })
  assert.equal(cased.matches.length, 2)
  const whole = find.pdfFindMatches(pages, 'alpha', { matchCase: false, wholeWord: true, regexp: false })
  assert.equal(whole.matches.length, 4)
  const regex = find.pdfFindMatches(pages, 'a\\w+a', { matchCase: false, wholeWord: false, regexp: true })
  assert.equal(regex.matches.length, 5)
  const invalid = find.pdfFindMatches(pages, '(', { matchCase: false, wholeWord: false, regexp: true })
  assert.equal(invalid.invalid, true)
  assert.equal(invalid.matches.length, 0)
})

check('查找结果超出上限时标记截断', () => {
  const pages = [['aaaa', 'aaaa'], ['aaaa', 'aaaa']]
  const result = find.pdfFindMatches(pages, 'a', { matchCase: false, wholeWord: false, regexp: false }, 5)
  assert.equal(result.matches.length, 5)
  assert.equal(result.capped, true)
  assert.equal(find.pdfFindMatches([], 'a', { matchCase: false, wholeWord: false, regexp: false }).matches.length, 0)
  assert.equal(find.pdfFindMatches([['a']], '', { matchCase: false, wholeWord: false, regexp: false }).matches.length, 0)
})

check('当前匹配定位到页，越界夹住', () => {
  const matches = [
    { page: 0, line: 0, start: 0, end: 1 },
    { page: 2, line: 0, start: 0, end: 1 },
    { page: 2, line: 1, start: 0, end: 1 }
  ]
  assert.equal(find.pdfMatchPage(matches, 0), 0)
  assert.equal(find.pdfMatchPage(matches, 1), 2)
  assert.equal(find.pdfMatchPage(matches, 99), 2)
  assert.equal(find.pdfMatchPage(matches, -5), 0)
  assert.equal(find.pdfMatchPage([], 0), -1)
  const byPage = find.pdfMatchPages(matches)
  assert.deepEqual([...byPage.keys()], [0, 2])
  assert.equal(byPage.get(2).length, 2)
})

process.stdout.write(`\n${passed} 组 PDF 预览逻辑测试通过\n`)
