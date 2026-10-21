import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const layout = fileURLToPath(new URL('../src/renderer/src/features/composer/composer-menu-layout.ts', import.meta.url))

const bundled = await build({
  stdin: {
    contents: `export * from ${JSON.stringify(layout.replace(/\\/g, '/'))}\n`,
    resolveDir: root,
    loader: 'ts'
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm'
})
const lib = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)
const {
  MENU_MAX_HEIGHT,
  MENU_GAP,
  MENU_EDGE,
  MENU_MAX_WIDTH,
  MENU_MIN_WIDTH,
  highlightParts,
  menuMaxHeight,
  menuMaxWidth,
  placeMenu,
  placeTooltip,
  tooltipMaxWidth
} = lib

const anchorAt = (top, left = 320) => ({ left, top, right: left + 1, bottom: top + 18 })
const viewport = { width: 1324, height: 820 }

const roomy = placeMenu({ anchor: anchorAt(700), size: { width: 300, height: 260 }, viewport })
assert.equal(roomy.maxHeight, Math.min(MENU_MAX_HEIGHT, 700 - 34), '最大高度取 min(384, caret.top-34)')
assert.equal(roomy.maxHeight, 384, '空间充足时最大高度封顶 384')
assert.equal(roomy.height, 260, '内容比上限矮时按内容高度')
assert.equal(roomy.top, 700 - MENU_GAP - 260, '向上展开，与光标间隔 10')
assert.equal(roomy.left, 320, '横向不越界时左对齐光标')
assert.equal(roomy.width, 300, '宽度不超过内容宽度')

const tall = placeMenu({ anchor: anchorAt(700), size: { width: 300, height: 900 }, viewport })
assert.equal(tall.height, 384, '内容超高时按最大高度裁剪')
assert.equal(tall.top, 700 - 10 - 384, '裁剪后仍与光标间隔 10')

const low = placeMenu({ anchor: anchorAt(200), size: { width: 300, height: 900 }, viewport })
assert.equal(low.maxHeight, 200 - 34, '贴近窗口顶部时按 caret.top-34 收缩')
assert.equal(low.top, 200 - 10 - (200 - 34), '收缩后仍向上展开')

const nearTop = placeMenu({ anchor: anchorAt(20), size: { width: 300, height: 200 }, viewport })
assert.equal(nearTop.maxHeight, 0, 'caret.top-34 为负时最大高度归零')
assert.equal(nearTop.top, 20 - MENU_GAP, '高度归零后停在光标上方，不越出窗口')

const right = placeMenu({ anchor: anchorAt(700, 1300), size: { width: 300, height: 200 }, viewport })
assert.equal(right.left, 1324 - 300 - MENU_EDGE, '右侧越界时整体左移，保留 8 的内边距')
assert.equal(right.left + right.width, 1324 - 8, '右边缘离窗口 8')

const wide = placeMenu({ anchor: anchorAt(700, 100), size: { width: 900, height: 120 }, viewport })
assert.equal(wide.maxWidth, MENU_MAX_WIDTH, '宽度上限 512')
assert.equal(wide.width, MENU_MAX_WIDTH, '超宽内容按 512 裁剪')

const narrow = placeMenu({ anchor: anchorAt(700, 2), size: { width: 300, height: 120 }, viewport: { width: 900, height: 700 } })
assert.equal(narrow.maxWidth, MENU_MAX_WIDTH, '900 宽窗口下宽度仍取 512 上限')
assert.equal(narrow.left, MENU_EDGE, '贴左边缘时保留 8 的内边距')
const narrowRight = placeMenu({ anchor: anchorAt(700, 880), size: { width: 300, height: 120 }, viewport: { width: 900, height: 700 } })
assert.equal(narrowRight.left, 900 - 300 - 8, '窄窗口下右侧内容左移')

const tight = placeMenu({ anchor: anchorAt(500, 40), size: { width: 900, height: 120 }, viewport: { width: 380, height: 600 } })
assert.equal(tight.maxWidth, 380 - 16, '窗口比 512 还窄时按窗口宽度减两侧内边距')
assert.equal(tight.width, 364, '裁剪后宽度不超过可用宽度')

assert.equal(menuMaxHeight({ top: 900 }), 384, 'menuMaxHeight 封装同一公式')
assert.equal(menuMaxWidth({ width: 1200, height: 800 }), 512, 'menuMaxWidth 封装同一上限')
assert.ok(MENU_MIN_WIDTH < MENU_MAX_WIDTH && MENU_EDGE === 8 && MENU_GAP === 10, '参考数值：最小宽 240、内边距 8、间距 10')

const tipRight = placeTooltip({
  menu: { left: 300, width: 320 },
  row: { top: 500, height: 24 },
  tooltip: { width: 260, height: 40 },
  viewport
})
assert.equal(tipRight.side, 'right', '右侧有空间时气泡在菜单右边')
assert.equal(tipRight.left, 300 + 320 + 8, '气泡与菜单间隔 8')
assert.equal(tipRight.top, 500 + 12 - 20, '气泡与高亮行垂直居中')

const tipLeft = placeTooltip({
  menu: { left: 900, width: 320 },
  row: { top: 500, height: 24 },
  tooltip: { width: 260, height: 40 },
  viewport
})
assert.equal(tipLeft.side, 'left', '右侧放不下时翻到左边')
assert.equal(tipLeft.left, 900 - 8 - 260, '翻转后仍保持间隔 8')

const tipClamp = placeTooltip({
  menu: { left: 300, width: 320 },
  row: { top: 10, height: 24 },
  tooltip: { width: 260, height: 40 },
  viewport
})
assert.equal(tipClamp.top, MENU_EDGE, '气泡不越出窗口上边缘')

const narrowMenu = { left: 540, width: 420 }
const narrowViewport = { width: 1324, height: 820 }
const room = tooltipMaxWidth(narrowMenu, narrowViewport)
assert.equal(room, 540 - 8 - 8, '气泡宽度不超过左右两侧较大的剩余空间')
const tipFits = placeTooltip({ menu: narrowMenu, row: { top: 500, height: 24 }, tooltip: { width: room, height: 40 }, viewport: narrowViewport })
assert.ok(tipFits.left + room <= narrowMenu.left - 8, '限宽后的气泡不压到菜单上')

const parts = highlightParts('/model', 'mod')
assert.deepEqual(
  parts,
  [
    { text: '/', hit: false },
    { text: 'mod', hit: true },
    { text: 'el', hit: false }
  ],
  '命中段单独切出，其余保持原文'
)
assert.deepEqual(highlightParts('AbcABC', 'abc'), [
  { text: 'Abc', hit: true },
  { text: 'ABC', hit: true }
], '命中不区分大小写，多处都加粗')
assert.deepEqual(highlightParts('没有命中', 'xyz'), [{ text: '没有命中', hit: false }], '不命中时只有一段原文')
assert.deepEqual(highlightParts('任意', ''), [{ text: '任意', hit: false }], '空查询不切分')
assert.deepEqual(highlightParts('', 'x'), [], '空文本没有分段')
assert.equal(highlightParts('模型', '模样').map((part) => part.text).join(''), '模型', '切分不改变文本')

const completionSource = fileURLToPath(new URL('../src/renderer/src/features/composer/useCompletion.ts', import.meta.url))
const completionBundle = await build({ entryPoints: [completionSource], bundle: true, write: false, platform: 'node', format: 'esm' })
const completion = await import(`data:text/javascript;base64,${Buffer.from(completionBundle.outputFiles[0].text).toString('base64')}`)

assert.equal(completion.toAbsoluteFilePath('/home/me/repo', 'src/a.ts'), '/home/me/repo/src/a.ts', 'POSIX 路径用正斜杠拼接')
assert.equal(completion.toAbsoluteFilePath('/home/me/repo/', 'src\\a.ts'), '/home/me/repo/src/a.ts', 'POSIX 路径把反斜杠归一成正斜杠')
assert.equal(completion.toAbsoluteFilePath('E:\\repo', 'src/a.ts'), 'E:\\repo\\src\\a.ts', 'Windows 路径用反斜杠拼接')
assert.equal(completion.toAbsoluteFilePath('E:\\repo', ''), 'E:\\repo', '空相对路径只返回根目录')

console.log('补全浮层定位：最大高/宽、向上锚定、边缘收边、气泡翻转、命中分段与绝对路径拼接检查通过')
