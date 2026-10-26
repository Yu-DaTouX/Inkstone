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

const lines = await load('features/preview/code-lines.ts')
const highlight = await load('lib/code-highlight.ts')
const settingsModel = await load('features/preview/file-view-settings.ts')
const state = await load('features/workbench/preview-state.ts')
const tabMenu = await load('features/preview/preview-tab-menu.ts')
const find = await load('features/preview/code-find.ts')
const goToLine = await load('features/preview/code-go-to-line.ts')
const lineComment = await load('features/preview/code-line-comment.ts')
const tabReorder = await load('features/preview/tab-reorder.ts')
const tabStrip = await load('features/preview/preview-tab-strip.ts')

let passed = 0
const check = (name, fn) => {
  fn()
  passed += 1
  process.stdout.write(`  ✓ ${name}\n`)
}
const checkAsync = async (name, fn) => {
  await fn()
  passed += 1
  process.stdout.write(`  ✓ ${name}\n`)
}

function makeFakeWorker({ respond = null, delayMs = 0 } = {}) {
  const worker = {
    terminated: false,
    posted: null,
    onmessage: null,
    onerror: null,
    postMessage(data) {
      worker.posted = data
      if (respond === null) return
      setTimeout(() => {
        if (worker.terminated) return
        worker.onmessage?.({ data: respond })
      }, delayMs)
    },
    terminate() {
      worker.terminated = true
    }
  }
  return worker
}

check('纯文本逐行切分，去掉行尾 \\r，保留末尾空行', () => {
  const out = lines.plainCodeLines('a\r\nb\n')
  assert.equal(out.length, 3)
  assert.deepEqual(out.map(lines.lineText), ['a', 'b', ''])
})

check('高亮树跨行 span 按行拆开，类名链保留', () => {
  const tree = {
    type: 'root',
    children: [
      { type: 'element', tagName: 'span', properties: { className: ['hljs-comment'] }, children: [{ type: 'text', value: '/* a\nb */' }] },
      { type: 'text', value: '\nx' }
    ]
  }
  const out = lines.splitHighlightedLines(tree, '/* a\nb */\nx')
  assert.equal(out.length, 3)
  assert.deepEqual(out[0], [{ text: '/* a', classes: ['hljs-comment'] }])
  assert.deepEqual(out[1], [{ text: 'b */', classes: ['hljs-comment'] }])
  assert.deepEqual(out[2], [{ text: 'x', classes: [] }])
})

check('真实 CSS 高亮后行数与原文一致，文本无损', () => {
  const css = ':root {\n  --bg: #fff;\n}\n@media (prefers-color-scheme: dark) {\n  :root { --bg: #111; }\n}\n'
  const tree = highlight.highlightTree(css, 'css', highlight.FILE_HIGHLIGHT_LIMITS)
  assert.ok(tree)
  const out = lines.splitHighlightedLines(tree, css)
  assert.deepEqual(out.map(lines.lineText), css.split('\n'))
  assert.ok(out[0].some((token) => token.classes.length > 0))
})

check('文件高亮上限独立于消息上限', () => {
  const big = 'a\n'.repeat(1500)
  assert.equal(highlight.exceedsHighlightLimits(big), true)
  assert.equal(highlight.exceedsHighlightLimits(big, highlight.FILE_HIGHLIGHT_LIMITS), false)
})

check('行号栏宽度至少 3 位，随末行号增长，窗口起点计入', () => {
  assert.equal(lines.numberColumnWidth(5), 3)
  assert.equal(lines.numberColumnWidth(1234), 4)
  assert.equal(lines.numberColumnWidth(10, 99995), 6)
})

check('跳转范围：非法行号为空，范围最多 200 行', () => {
  assert.equal(lines.jumpRange(undefined), null)
  assert.equal(lines.jumpRange(0), null)
  assert.deepEqual(lines.jumpRange(5), { first: 5, last: 5 })
  assert.deepEqual(lines.jumpRange(5, 3), { first: 5, last: 5 })
  assert.deepEqual(lines.jumpRange(10, 1000), { first: 10, last: 209 })
})

check('末行下滚动留白公式', () => {
  assert.equal(lines.scrollPastEndPadding(400, 17, 4), 378.5)
  assert.equal(lines.scrollPastEndPadding(10, 17, 4), 0)
})

check('缩进单位与参考线层级：两空格缩进、空行取上下较小值、Tab 按宽度换算', () => {
  const texts = [':root {', '  a;', '', '  b {', '    c;', '  }', '}']
  const guides = lines.guideLevels(texts, 4)
  assert.equal(guides.unit, 2)
  assert.deepEqual(guides.levels, [0, 1, 1, 1, 2, 1, 0])
  assert.equal(lines.leadingColumns('\t\tx', 4), 8)
  assert.equal(lines.leadingColumns('  \tx', 4), 4)
  assert.equal(lines.leadingColumns('   ', 4), null)
  assert.equal(lines.indentUnit(['\tx'], 8), 8)
  assert.equal(lines.indentUnit(['\tx', '  y'], 4), 2)
})

check('按缩进推导折叠区间，折叠后可见行与跳转展开', () => {
  const texts = [':root {', '  a;', '', '  b {', '    c;', '  }', '}', 'x']
  const regions = lines.foldRegions(texts, 4)
  assert.equal(regions.get(0), 5)
  assert.equal(regions.get(3), 4)
  assert.equal(regions.has(6), false)
  const rows = lines.visibleLineIndexes(texts.length, regions, new Set([0]))
  assert.deepEqual(rows, [0, 6, 7])
  assert.equal(lines.rowIndexOfLine(rows, 6), 1)
  assert.equal(lines.rowIndexOfLine(rows, 4), -1)
  const unfolded = lines.unfoldToReveal(regions, new Set([0, 3]), 4)
  assert.deepEqual([...unfolded], [])
  assert.deepEqual([...lines.unfoldToReveal(regions, new Set([3]), 1)], [3])
})

check('文本预览按 20000 行封顶，正好等于上限时不截断', () => {
  const long = Array.from({ length: 25_000 }, (_, i) => `line ${i}`).join('\n')
  const capped = lines.capCodeText(long)
  assert.equal(capped.capped, true)
  assert.equal(capped.text.split('\n').length, lines.CODE_LINE_LIMIT)
  assert.equal(capped.text.split('\n').at(-1), 'line 19999')
  const exact = Array.from({ length: lines.CODE_LINE_LIMIT }, (_, i) => `line ${i}`).join('\n')
  assert.deepEqual(lines.capCodeText(exact), { text: exact, capped: false })
  assert.deepEqual(lines.capCodeText('a\nb'), { text: 'a\nb', capped: false })
  assert.deepEqual(lines.capCodeText('a\nb', 2), { text: 'a\nb', capped: false })
  assert.deepEqual(lines.capCodeText('a\nb\nc', 2), { text: 'a\nb', capped: true })
})

check('缩进列与折叠区间：与大输入下的朴素实现逐行一致', () => {
  const lead = (text) => {
    let columns = 0
    for (let i = 0; i < text.length; i += 1) {
      const ch = text.charCodeAt(i)
      if (ch === 32) columns += 1
      else if (ch === 9) columns += 4 - (columns % 4)
      else return columns
    }
    return null
  }
  const naiveIndent = (texts) => {
    const raw = texts.map(lead)
    return raw.map((value, i) => {
      if (value !== null) return value
      let previous = 0
      for (let j = i - 1; j >= 0; j -= 1) {
        if (raw[j] !== null) {
          previous = raw[j]
          break
        }
      }
      let next = 0
      for (let j = i + 1; j < raw.length; j += 1) {
        if (raw[j] !== null) {
          next = raw[j]
          break
        }
      }
      return Math.min(previous, next)
    })
  }
  const naiveFold = (texts) => {
    const raw = texts.map(lead)
    const regions = new Map()
    for (let i = 0; i < raw.length; i += 1) {
      const indent = raw[i]
      if (indent === null) continue
      let end = -1
      for (let j = i + 1; j < raw.length; j += 1) {
        const value = raw[j]
        if (value === null) continue
        if (value <= indent) break
        end = j
      }
      if (end > i) regions.set(i, end)
    }
    return regions
  }
  const shapes = [
    Array.from({ length: 300 }, (_, i) => ' '.repeat(i % 7 === 0 ? 0 : (i % 3) * 2) + (i % 5 === 0 ? '' : `x${i}`)),
    Array.from({ length: 400 }, (_, i) => (i % 11 === 0 ? '' : '  '.repeat(Math.min(i, 40)) + 'y')),
    Array.from({ length: 200 }, (_, i) => (i % 3 === 0 ? '' : '    z')),
    []
  ]
  for (const texts of shapes) {
    assert.deepEqual(lines.indentColumns(texts, 4), naiveIndent(texts))
    assert.deepEqual([...lines.foldRegions(texts, 4).entries()].sort((a, b) => a[0] - b[0]), [...naiveFold(texts).entries()].sort((a, b) => a[0] - b[0]))
  }
  assert.deepEqual(lines.foldRegions(['a', '', ''], 4).size, 0)
})

check('视图设置：默认值、非法值回落、写入与 storage 事件同步', () => {
  const store = new Map()
  const storage = { getItem: (key) => (store.has(key) ? store.get(key) : null), setItem: (key, value) => store.set(key, value) }
  let emit = () => {}
  const settings = settingsModel.createFileViewSettings({ storage, subscribeStorage: (listener) => ((emit = listener), () => {}) })
  assert.deepEqual(settings.getSnapshot(), settingsModel.DEFAULT_FILE_VIEW_SETTINGS)
  let calls = 0
  settings.subscribe(() => (calls += 1))
  settings.set('tabSize', 8)
  settings.set('wordWrap', false)
  assert.equal(settings.getSnapshot().tabSize, 8)
  assert.equal(settings.getSnapshot().wordWrap, false)
  assert.equal(store.get('yan.files.tabSize'), '8')
  assert.equal(calls, 2)
  settings.set('wordWrap', false)
  assert.equal(calls, 2)
  store.set('yan.files.tabSize', '3')
  store.set('yan.files.showWhitespace', 'true')
  emit({ key: 'yan.files.tabSize' })
  assert.equal(settings.getSnapshot().tabSize, 4)
  assert.equal(settings.getSnapshot().showWhitespace, true)
  store.set('yan.files.previewTabs', '{oops')
  assert.equal(settingsModel.readFileViewSettings(storage).previewTabs, true)
  assert.equal(settingsModel.readFileViewSettings(null).indentGuides, true)
})

check('预览标签：单击占预览槽，再单击替换原位，双击或固定后保留', () => {
  let b = new Map()
  b = state.openPreviewTab(b, 'o', 'C:/w/a.css')
  b = state.openPreviewTab(b, 'o', 'C:/w/b.css', { preview: true })
  assert.deepEqual(b.get('o').tabs, ['C:/w/a.css', 'C:/w/b.css'])
  assert.equal(b.get('o').preview, 'C:/w/b.css')
  b = state.openPreviewTab(b, 'o', 'C:/w/c.css', { preview: true })
  assert.deepEqual(b.get('o').tabs, ['C:/w/a.css', 'C:/w/c.css'])
  assert.equal(b.get('o').active, 'C:/w/c.css')
  b = state.openPreviewTab(b, 'o', 'C:/w/c.css', { preview: false })
  assert.equal(b.get('o').preview, undefined)
  b = state.openPreviewTab(b, 'o', 'C:/w/d.css', { preview: true })
  b = state.keepPreviewTab(b, 'o', 'C:/w/d.css')
  assert.equal(b.get('o').preview, undefined)
  b = state.openPreviewTab(b, 'o', 'C:/w/e.css', { preview: true })
  assert.deepEqual(b.get('o').tabs, ['C:/w/a.css', 'C:/w/c.css', 'C:/w/d.css', 'C:/w/e.css'])
  b = state.openPreviewTab(b, 'o', 'C:/w/a.css', { preview: true })
  assert.equal(b.get('o').preview, 'C:/w/e.css')
  assert.equal(state.keepAllPreviewTabs(b).get('o').preview, undefined)
})

check('跳转目标随打开记录，换别的文件不丢，重开同一文件清除', () => {
  let b = new Map()
  b = state.openPreviewTab(b, 'o', 'C:/w/a.ts', { line: 12, lineEnd: 14 })
  const first = b.get('o').target
  assert.equal(first.path, 'C:/w/a.ts')
  assert.equal(first.line, 12)
  assert.equal(first.lineEnd, 14)
  b = state.openPreviewTab(b, 'o', 'C:/w/a.ts', { line: 12 })
  assert.ok(b.get('o').target.nonce > first.nonce)
  b = state.openPreviewTab(b, 'o', 'C:/w/b.ts')
  assert.equal(b.get('o').target.path, 'C:/w/a.ts')
  b = state.openPreviewTab(b, 'o', 'C:/w/a.ts')
  assert.equal(b.get('o').target, undefined)
})

check('关闭右侧、关闭其他、关闭预览标签时清理预览标记', () => {
  let b = new Map()
  for (const p of ['a', 'b', 'c', 'd']) b = state.openPreviewTab(b, 'o', p)
  b = state.openPreviewTab(b, 'o', 'e', { preview: true })
  b = state.selectPreviewTab(b, 'o', 'd')
  const right = state.closePreviewTabsToRight(b, 'o', 'b')
  assert.deepEqual(right.get('o').tabs, ['a', 'b'])
  assert.equal(right.get('o').active, 'b')
  assert.equal(right.get('o').preview, undefined)
  assert.equal(state.closePreviewTabsToRight(b, 'o', 'e'), b)
  assert.deepEqual(state.previewTabsToRight(['a', 'b', 'c'], 'a'), ['b', 'c'])
  const others = state.closeOtherPreviewTabs(b, 'o', 'e')
  assert.deepEqual(others.get('o').tabs, ['e'])
  assert.equal(others.get('o').preview, 'e')
  assert.equal(state.closePreviewTab(b, 'o', 'e').get('o').preview, undefined)
})

check('标签悬停提示用工作目录内的相对路径', () => {
  assert.equal(state.previewTabDetail('C:\\w\\src\\a.ts', 'C:\\w'), 'src/a.ts')
  assert.equal(state.previewTabDetail('D:/x/a.ts', 'C:/w'), 'D:/x/a.ts')
})

check('标签右键菜单：预览才有保持打开，单个标签没有关闭其他/全部，末尾没有关闭右侧', () => {
  const tabs = ['C:/w/a.ts', 'C:/w/src/b.ts']
  const first = tabMenu.previewTabMenu({ path: tabs[0], cwd: 'C:/w', tabs, preview: false, canRevealInTree: true })
  assert.deepEqual(first.tabActions, ['close', 'close-others', 'close-right', 'close-all'])
  assert.equal(first.revealInTree, true)
  const last = tabMenu.previewTabMenu({ path: tabs[1], cwd: 'C:/w', tabs, preview: true, canRevealInTree: true })
  assert.deepEqual(last.tabActions, ['keep', 'close', 'close-others', 'close-all'])
  assert.deepEqual(last.copy, { absolute: 'C:/w/src/b.ts', relative: 'src/b.ts', name: 'b.ts' })
  const solo = tabMenu.previewTabMenu({ path: 'D:/o/x.md', cwd: 'C:/w', tabs: ['D:/o/x.md'], preview: false, canRevealInTree: true })
  assert.deepEqual(solo.tabActions, ['close'])
  assert.equal(solo.copy.relative, null)
  assert.equal(solo.revealInTree, false)
})

check('标签键盘：Delete/Backspace 关闭，Shift+F10/菜单键打开菜单', () => {
  const none = { ctrl: false, shift: false, alt: false, meta: false }
  assert.equal(tabMenu.previewTabKeyAction('Delete', none), 'close')
  assert.equal(tabMenu.previewTabKeyAction('Backspace', none), 'close')
  assert.equal(tabMenu.previewTabKeyAction('Delete', { ...none, ctrl: true }), null)
  assert.equal(tabMenu.previewTabKeyAction('F10', { ...none, shift: true }), 'menu')
  assert.equal(tabMenu.previewTabKeyAction('ContextMenu', none), 'menu')
  assert.equal(tabMenu.previewTabKeyAction('a', none), null)
})

check('换行续行缩进：行首列数按 Tab 宽度换算，空白行归零', () => {
  assert.deepEqual(lines.wrapIndentColumns([':root {', '  a;', '', '\tb', '   '], 4), [0, 2, 0, 4, 0])
  assert.deepEqual(lines.wrapIndentColumns(['  \tx'], 8), [8])
  assert.deepEqual(lines.wrapIndentColumns([], 4), [])
})

check('查找：字面量不分大小写，可开关大小写与全词', () => {
  const texts = ['const a = A;', 'a variable', 'Aa']
  const plain = find.findMatches(texts, 'a')
  assert.equal(plain.invalid, false)
  assert.deepEqual(plain.matches.map((m) => [m.line, m.start, m.end]), [
    [0, 6, 7],
    [0, 10, 11],
    [1, 0, 1],
    [1, 3, 4],
    [1, 6, 7],
    [2, 0, 1],
    [2, 1, 2]
  ])
  const cased = find.findMatches(texts, 'A', { matchCase: true, wholeWord: false, regexp: false })
  assert.deepEqual(cased.matches.map((m) => [m.line, m.start]), [[0, 10], [2, 0]])
  const word = find.findMatches(texts, 'a', { matchCase: true, wholeWord: true, regexp: false })
  assert.deepEqual(word.matches.map((m) => [m.line, m.start]), [[0, 6], [1, 0]])
})

check('查找：正则与无效模式，零长度匹配不卡死，结果按上限截断', () => {
  const texts = ['foo(1) bar(2)', 'baz']
  const regex = find.findMatches(texts, '\\(\\d\\)', { matchCase: false, wholeWord: false, regexp: true })
  assert.deepEqual(regex.matches.map((m) => [m.line, m.start, m.end]), [[0, 3, 6], [0, 10, 13]])
  assert.equal(find.findMatches(texts, '(', { matchCase: false, wholeWord: false, regexp: true }).invalid, true)
  assert.equal(find.findMatches(texts, 'x*', { matchCase: false, wholeWord: false, regexp: true }).matches.length, 0)
  const capped = find.findMatches(['aaaa'], 'a', find.DEFAULT_FIND_OPTIONS, 3)
  assert.equal(capped.matches.length, 3)
  assert.equal(capped.capped, true)
  assert.equal(find.findMatches([], 'a').matches.length, 0)
  assert.equal(find.findMatches(['a'], '').matches.length, 0)
})

await checkAsync('查找会话：字面搜索走同步快路径，不创建 worker', async () => {
  let created = 0
  const session = find.createFindSession(1000, () => {
    created += 1
    return makeFakeWorker()
  })
  const texts = ['const a = A;', 'a variable', 'Aa']
  const options = { matchCase: false, wholeWord: false, regexp: false }
  const result = await session.find(texts, 'a', options)
  assert.deepEqual(result, find.findMatches(texts, 'a', options))
  assert.equal(created, 0, '字面搜索不应创建 worker')
})

await checkAsync('查找会话：正则搜索交给 worker，返回其结果并终止 worker', async () => {
  const fakeResult = { matches: [{ line: 0, start: 0, end: 1 }], invalid: false, capped: false }
  const worker = makeFakeWorker({ respond: fakeResult, delayMs: 5 })
  const session = find.createFindSession(1000, () => worker)
  const result = await session.find(['a'], 'a', { matchCase: false, wholeWord: false, regexp: true })
  assert.deepEqual(result, fakeResult)
  assert.equal(worker.terminated, true, '拿到结果后应终止 worker')
})

await checkAsync('查找会话：worker 超时会被终止并按正则无效处理', async () => {
  const worker = makeFakeWorker({ respond: null })
  const session = find.createFindSession(20, () => worker)
  const result = await session.find(['a'], '(a+)+b', { matchCase: false, wholeWord: false, regexp: true })
  assert.equal(result.invalid, true, '超时应复用正则无效状态')
  assert.equal(result.matches.length, 0)
  assert.equal(worker.terminated, true, '超时后应终止 worker')
})

await checkAsync('查找会话：新查询到来时终止旧 worker，只采用最新结果', async () => {
  const first = makeFakeWorker({ respond: null })
  const secondResult = { matches: [{ line: 0, start: 0, end: 1 }], invalid: false, capped: false }
  const second = makeFakeWorker({ respond: secondResult, delayMs: 5 })
  const workers = [first, second]
  const session = find.createFindSession(1000, () => workers.shift())
  const firstPromise = session.find(['a'], 'first', { matchCase: false, wholeWord: false, regexp: true })
  const secondPromise = session.find(['a'], 'second', { matchCase: false, wholeWord: false, regexp: true })
  const [firstOutcome, secondOutcome] = await Promise.all([firstPromise, secondPromise])
  assert.equal(first.terminated, true, '旧 worker 应被终止')
  assert.equal(firstOutcome.invalid, false)
  assert.equal(firstOutcome.matches.length, 0, '被取消的旧查询不应带出结果')
  assert.deepEqual(secondOutcome, secondResult)
})

await checkAsync('查找会话：dispose 终止尚未完成的 worker', async () => {
  const worker = makeFakeWorker({ respond: null })
  const session = find.createFindSession(1000, () => worker)
  const pending = session.find(['a'], 'x', { matchCase: false, wholeWord: false, regexp: true })
  session.dispose()
  const result = await pending
  assert.equal(worker.terminated, true)
  assert.equal(result.invalid, false)
})

check('查找：步进环绕、状态、从当前行起选首个匹配', () => {
  assert.equal(find.stepFindIndex(-1, 1, 4), 0)
  assert.equal(find.stepFindIndex(3, 1, 4), 0)
  assert.equal(find.stepFindIndex(0, -1, 4), 3)
  assert.equal(find.stepFindIndex(0, 1, 0), -1)
  assert.deepEqual(find.findStatus(-1, 0, false), { current: 0, total: 0, capped: false })
  assert.deepEqual(find.findStatus(2, 10, true), { current: 3, total: 10, capped: true })
  const matches = [{ line: 2, start: 0, end: 1 }, { line: 5, start: 0, end: 1 }]
  assert.equal(find.firstMatchFromLine(matches, 4), 1)
  assert.equal(find.firstMatchFromLine(matches, 9), 0)
  assert.equal(find.firstMatchFromLine(matches, null), 0)
  assert.equal(find.firstMatchFromLine([], 1), -1)
})

check('查找：跨 token 拆出匹配片段，活动匹配标出', () => {
  const line = [
    { text: 'const ', classes: ['hljs-keyword'] },
    { text: 'value', classes: [] }
  ]
  const segments = find.splitLineMatches(line, [{ start: 6, end: 11 }])
  assert.deepEqual(
    segments.map((s) => [s.text, s.start, s.match]),
    [
      ['const ', 0, false],
      ['value', 6, true]
    ]
  )
  const split = find.splitLineMatches([{ text: 'abcdef', classes: [] }], [{ start: 1, end: 3 }, { start: 4, end: 5 }])
  assert.deepEqual(
    split.map((s) => [s.text, s.start, s.match]),
    [
      ['a', 0, false],
      ['bc', 1, true],
      ['d', 3, false],
      ['e', 4, true],
      ['f', 5, false]
    ]
  )
  const byLine = find.matchesByLine([{ line: 1, start: 0, end: 2 }, { line: 1, start: 4, end: 5 }])
  assert.equal(byLine.get(1).length, 2)
})

check('查找：快捷键只接管 Ctrl/⌘+F，Enter/Shift+Enter 与 F3 步进', () => {
  const none = { key: 'f', ctrl: false, meta: false, alt: false, shift: false }
  assert.equal(find.findShortcut({ ...none, key: 'f', ctrl: true }, false), 'open')
  assert.equal(find.findShortcut({ ...none, key: 'f', meta: true }, true), 'open')
  assert.equal(find.findShortcut({ ...none, key: 'f', ctrl: true }, true), null)
  assert.equal(find.findShortcut({ ...none, key: 'f', ctrl: true, shift: true }, false), null)
  assert.equal(find.findShortcut({ ...none, key: 'f', ctrl: true, alt: true }, false), null)
  assert.equal(find.findShortcut({ ...none, key: 'g', ctrl: true }, false), null)
  assert.equal(find.findStepKey('Enter', false), 1)
  assert.equal(find.findStepKey('Enter', true), -1)
  assert.equal(find.findStepKey('F3', false), 1)
  assert.equal(find.findStepKey('F3', true), -1)
  assert.equal(find.findStepKey('a', false), null)
})

check('跳行：解析行号与行列，越界拒绝，Ctrl+G 触发', () => {
  assert.deepEqual(goToLine.parseLineLocation('12'), { line: 12 })
  assert.deepEqual(goToLine.parseLineLocation(' 12 : 4 '), { line: 12, column: 4 })
  assert.deepEqual(goToLine.parseLineLocation('7:'), { line: 7 })
  assert.deepEqual(goToLine.parseLineLocation('7:0'), { line: 7 })
  assert.equal(goToLine.parseLineLocation('0'), null)
  assert.equal(goToLine.parseLineLocation('-3'), null)
  assert.equal(goToLine.parseLineLocation('1.5'), null)
  assert.equal(goToLine.parseLineLocation('a:1'), null)
  assert.equal(goToLine.parseLineLocation(''), null)
  assert.deepEqual(goToLine.validateLineLocation({ line: 10, column: 3 }, 10), { line: 10, column: 3 })
  assert.equal(goToLine.validateLineLocation({ line: 11 }, 10), null)
  assert.equal(goToLine.validateLineLocation(null, 10), null)
  assert.equal(goToLine.validateLineLocation({ line: 999 }, 1499, 1000), null)
  assert.deepEqual(goToLine.validateLineLocation({ line: 1200 }, 1499, 1000), { line: 1200 })
  const key = { key: 'g', ctrl: true, meta: false, alt: false, shift: false }
  assert.equal(goToLine.goToLineShortcut(key), true)
  assert.equal(goToLine.goToLineShortcut({ ...key, code: 'KeyG', key: 'и' }), true)
  assert.equal(goToLine.goToLineShortcut({ ...key, ctrl: false, meta: true }), false)
  assert.equal(goToLine.goToLineShortcut({ ...key, shift: true }), false)
  assert.equal(goToLine.goToLineShortcut({ ...key, key: 'h' }), false)
})

check('行评论：范围归一与行数夹取，引用代码带行号窗口并截断', () => {
  assert.deepEqual(lineComment.commentRange(5, 3, 10), { start: 3, end: 5 })
  assert.deepEqual(lineComment.commentRange(2, 2, 10), { start: 2, end: 2 })
  assert.deepEqual(lineComment.commentRange(1, 99, 10), { start: 1, end: 10 })
  assert.equal(lineComment.commentRange(11, 12, 10), null)
  assert.equal(lineComment.commentRange(0, 2, 10), null)
  assert.equal(lineComment.commentRange(1, 2, 0), null)
  const texts = ['a', 'b', 'c', 'd']
  assert.deepEqual(lineComment.commentQuoteLines(texts, 10, { start: 11, end: 12 }), ['b', 'c'])
  assert.deepEqual(lineComment.commentQuoteLines(texts, 1, { start: 1, end: 4 }, 3), ['a', 'b', '…'])
  assert.deepEqual(lineComment.commentQuoteLines(texts, 10, { start: 41, end: 42 }), [])
})

check('行评论：中文与英文序列化，空评论不入输入框', () => {
  const zh = lineComment.serializeLineComment({
    path: 'src\\a.ts',
    start: 4,
    end: 6,
    code: '  one\n  two',
    text: '  why?  ',
    lang: 'zh-CN'
  })
  assert.equal(zh, '在 src/a.ts 第 4–6 行：\n> one\n>   two\nwhy?')
  const single = lineComment.serializeLineComment({ path: 'a.ts', start: 2, end: 2, code: '', text: 'note', lang: 'en-US' })
  assert.equal(single, 'In a.ts, line 2:\nnote')
  assert.equal(lineComment.serializeLineComment({ path: 'a.ts', start: 2, end: 3, code: 'x', text: '   ', lang: 'en-US' }), '')
  assert.equal(lineComment.lineCommentLabel({ start: 2, end: 2 }, 'en-US'), 'Line 2')
  assert.equal(lineComment.lineCommentLabel({ start: 2, end: 5 }, 'zh-CN'), '第 2–5 行')
})

check('预览标签拖动：重排保留活动/预览/跳转，落点与插入位置换算', () => {
  let b = new Map()
  for (const p of ['a', 'b', 'd']) b = state.openPreviewTab(b, 'o', p)
  b = state.openPreviewTab(b, 'o', 'c', { preview: true })
  b = state.openPreviewTab(b, 'o', 'a', { line: 3 })
  const moved = state.movePreviewTab(b, 'o', 'd', 1)
  assert.deepEqual(moved.get('o').tabs, ['a', 'd', 'b', 'c'])
  assert.equal(moved.get('o').active, 'a')
  assert.equal(moved.get('o').preview, 'c')
  assert.equal(moved.get('o').target.line, 3)
  assert.equal(state.movePreviewTab(b, 'o', 'a', 0), b)
  assert.equal(state.movePreviewTab(b, 'o', 'nope', 1), b)
  assert.equal(state.movePreviewTab(b, null, 'a', 1), b)
  assert.equal(state.movePreviewTab(b, 'o', 'a', 99).get('o').tabs[3], 'a')
  assert.deepEqual(tabReorder.moveToIndex(['a', 'b', 'c'], 0, 2), ['b', 'c', 'a'])
  assert.deepEqual(tabReorder.dropIndexFor([10, 30, 50], 31), 2)
  assert.equal(tabReorder.dropIndexFor([], 5), 0)
  assert.equal(tabReorder.dropGapIndex(2, 0), 3)
  assert.equal(tabReorder.dropGapIndex(1, 3), 1)
  assert.equal(tabReorder.tabMoveKey({ key: 'ArrowRight', ctrl: true, meta: false, alt: false, shift: true }), 1)
  assert.equal(tabReorder.tabMoveKey({ key: 'ArrowLeft', ctrl: true, meta: false, alt: false, shift: true }), -1)
  assert.equal(tabReorder.tabMoveKey({ key: 'ArrowLeft', ctrl: true, meta: false, alt: false, shift: false }), null)
})

check('预览标签上限：超过 8 个时淘汰最早的标签，保留新标签与预览槽', () => {
  let b = new Map()
  for (const p of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']) b = state.openPreviewTab(b, 'o', p)
  assert.equal(b.get('o').tabs.length, 8)
  assert.deepEqual(b.get('o').tabs[0], 'b')
  assert.equal(b.get('o').tabs.at(-1), 'i')
  let pv = new Map()
  for (const p of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) pv = state.openPreviewTab(pv, 'o', p)
  pv = state.openPreviewTab(pv, 'o', 'p1', { preview: true })
  pv = state.openPreviewTab(pv, 'o', 'p2', { preview: true })
  assert.equal(pv.get('o').tabs.length, 8)
  assert.ok(pv.get('o').tabs.includes('p2'))
  assert.equal(pv.get('o').preview, 'p2')
  assert.equal(pv.get('o').tabs[0], 'b')
})

check('预览标签持久化：读写往返、非法数据丢弃、活动与预览标记保留', () => {
  let b = new Map()
  b = state.openPreviewTab(b, 'owner-1', 'C:/w/a.ts')
  b = state.openPreviewTab(b, 'owner-1', 'C:/w/b.ts', { preview: true })
  b = state.openPreviewTab(b, 'owner-2', 'C:/w/c.ts')
  const raw = state.serializePreviewBindings(b)
  const back = state.parsePreviewBindings(raw)
  assert.deepEqual(back.get('owner-1').tabs, ['C:/w/a.ts', 'C:/w/b.ts'])
  assert.equal(back.get('owner-1').active, 'C:/w/b.ts')
  assert.equal(back.get('owner-1').preview, 'C:/w/b.ts')
  assert.deepEqual(back.get('owner-2').tabs, ['C:/w/c.ts'])
  assert.equal(state.parsePreviewBindings('{oops').size, 0)
  assert.equal(state.parsePreviewBindings(null).size, 0)
  assert.equal(state.parsePreviewBindings('{"owners":{"k":{"tabs":[]}}}').size, 0)
  const repaired = state.parsePreviewBindings('{"owners":{"k":{"tabs":["a","a","b"],"active":"z","preview":"z"}}}')
  assert.deepEqual(repaired.get('k').tabs, ['a', 'b'])
  assert.equal(repaired.get('k').active, 'a')
  assert.equal(repaired.get('k').preview, undefined)
  const store = {
    data: new Map(),
    getItem(key) {
      return this.data.get(key) ?? null
    },
    setItem(key, value) {
      this.data.set(key, value)
    }
  }
  state.writePreviewBindings(store, b)
  assert.equal(state.readPreviewBindings(store).get('owner-1').tabs.length, 2)
  assert.equal(state.readPreviewBindings(null).size, 0)
})

check('预览标签目录：工具提示的第二行只给相对目录', () => {
  assert.equal(state.previewTabDirectory('C:\\w\\src\\a.ts', 'C:\\w'), 'src')
  assert.equal(state.previewTabDirectory('C:/w/src/deep/b.ts', 'C:/w'), 'src/deep')
  assert.equal(state.previewTabDirectory('C:/w/a.ts', 'C:/w'), undefined)
  assert.equal(state.previewTabDirectory('D:/x/a.ts', 'C:/w'), 'D:/x')
})

check('标签条：放得下时不滚动、不隐藏', () => {
  const tabs = [{ id: 'a', start: 0, end: 100 }, { id: 'b', start: 102, end: 200 }]
  assert.deepEqual(tabStrip.tabStripLayout({ tabs, width: 300, scrollLeft: 40, maxScroll: 0, activeId: 'a' }), { scrollLeft: 0, hiddenIds: [], overflowing: false })
})

check('标签条：滚动吸附到标签起点，左侧不出现半截标签', () => {
  const tabs = Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, start: i * 100, end: i * 100 + 98 }))
  const out = tabStrip.tabStripLayout({ tabs, width: 250, scrollLeft: 0, maxScroll: 348, activeId: 't5' })
  assert.equal(out.scrollLeft, 348)
  assert.deepEqual(out.hiddenIds, ['t0', 't1', 't2', 't3'])
})

check('标签条：右侧超出一部分的非当前标签收进溢出菜单', () => {
  const tabs = Array.from({ length: 4 }, (_, i) => ({ id: `t${i}`, start: i * 100, end: i * 100 + 98 }))
  const out = tabStrip.tabStripLayout({ tabs, width: 250, scrollLeft: 0, maxScroll: 148, activeId: 't0' })
  assert.equal(out.scrollLeft, 0)
  assert.deepEqual(out.hiddenIds, ['t2', 't3'])
})

check('标签条：当前标签在左侧视野外时滚回它的起点', () => {
  const tabs = Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, start: i * 100, end: i * 100 + 98 }))
  const out = tabStrip.tabStripLayout({ tabs, width: 250, scrollLeft: 300, maxScroll: 348, activeId: 't1' })
  assert.equal(out.scrollLeft, 100)
  assert.ok(!out.hiddenIds.includes('t1'))
})

process.stdout.write(`test-preview-code-view: ${passed} 项通过\n`)
