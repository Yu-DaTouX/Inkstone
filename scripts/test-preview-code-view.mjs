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

let passed = 0
const check = (name, fn) => {
  fn()
  passed += 1
  process.stdout.write(`  ✓ ${name}\n`)
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

process.stdout.write(`test-preview-code-view: ${passed} 项通过\n`)
