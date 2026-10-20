import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const edit = fileURLToPath(new URL('../src/renderer/src/features/composer/composer-edit.ts', import.meta.url))
const text = fileURLToPath(new URL('../src/renderer/src/features/composer/composer-text.ts', import.meta.url))

const bundled = await build({
  stdin: {
    contents: `export * from ${JSON.stringify(edit.replace(/\\/g, '/'))}
export * from ${JSON.stringify(text.replace(/\\/g, '/'))}
export { EditorState, TextSelection, NodeSelection } from 'prosemirror-state'
`,
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
  inlineNodesForText,
  atomInsertTransaction,
  caretInCode,
  codeBlockEnterTransaction,
  fenceTransaction,
  inputRuleTransaction,
  reconcileTextTransaction,
  selectAtomBefore,
  structureTransaction,
  countStructure,
  docToText,
  textToDoc,
  textOffsetForPosition,
  composerSchema,
  EditorState,
  TextSelection,
  NodeSelection
} = lib

const stateOf = (value, options = {}) =>
  EditorState.create({ doc: textToDoc(value, options), selection: TextSelection.atStart(textToDoc(value, options)) })

const plainStateOf = (value) => {
  const doc = composerSchema.node('doc', null, [
    composerSchema.node('paragraph', null, inlineNodesForText(value))
  ])
  return EditorState.create({ doc, selection: TextSelection.create(doc, doc.content.size - 1) })
}

const endOf = (state) =>
  state.apply(state.tr.setSelection(TextSelection.create(state.doc, state.doc.content.size - 1)))

function nodeAt(doc, predicate) {
  let found = null
  doc.descendants((node) => {
    if (found) return false
    if (predicate(node)) found = node
    return !found
  })
  return found
}

const slashState = endOf(stateOf('/mo', { commands: ['model'] }))
const slashTr = atomInsertTransaction(
  slashState,
  { start: 0, end: 3 },
  { kind: 'command', raw: '/model', path: 'model' },
  ' '
)
assert.ok(slashTr, '命令补全落成 chip 事务')
assert.equal(docToText(slashTr.doc), '/model ', '命令 chip 之后保留原来的尾空格，文本与纯文本补全一致')
assert.equal(
  nodeAt(slashTr.doc, (node) => node.type.name === 'command_chip')?.attrs.id,
  'model',
  '命令 chip 记住命令名'
)
assert.equal(textOffsetForPosition(slashTr.doc, slashTr.selection.from), 7, '光标落在 chip 与空格之后')

const quotedState = endOf(stateOf('@"my di'))
const quotedTr = atomInsertTransaction(
  quotedState,
  { start: 0, end: 7 },
  { kind: 'mention', raw: '@"my dir/a b.ts"', path: 'my dir/a b.ts' },
  ' '
)
assert.ok(quotedTr, '带空格路径的提及落成 chip 事务')
assert.equal(docToText(quotedTr.doc), '@"my dir/a b.ts" ', '提及 chip 序列化还原引号')
assert.equal(
  nodeAt(quotedTr.doc, (node) => node.type.name === 'mention')?.attrs.path,
  'my dir/a b.ts',
  '提及 chip 存去引号的路径'
)

const imageState = endOf(stateOf('@图', { imageCount: 2 }))
const imageTr = atomInsertTransaction(
  imageState,
  { start: 0, end: 2 },
  { kind: 'image', raw: '@图2', path: '图2' },
  ' '
)
assert.ok(imageTr, '图片引用落成 chip 事务')
assert.equal(docToText(imageTr.doc), '@图2 ', '图片引用 chip 序列化保留编号')

const mismatched = atomInsertTransaction(
  endOf(stateOf('/model 用力', { commands: ['model'] })),
  { start: 0, end: 3 },
  { kind: 'command', raw: '/x', path: 'x' }
)
assert.ok(mismatched === null, '文档位置对不上文本区间时拒绝原子插入，退回纯文本')

const chipState = endOf(stateOf('/model 用力', { commands: ['model'] }))
const afterChip = chipState.apply(
  chipState.tr.setSelection(TextSelection.create(chipState.doc, 2))
)
let selected = null
assert.equal(
  selectAtomBefore(afterChip, (tr) => {
    selected = tr
  }),
  true,
  '紧跟 chip 的 Backspace 先整块选中'
)
assert.ok(selected?.selection instanceof NodeSelection, '选中整块 chip 而非单个字符')
const withSelection = afterChip.apply(selected)
const deleted = withSelection.apply(withSelection.tr.deleteSelection())
assert.equal(docToText(deleted.doc), ' 用力', '整块删除 chip 只去掉 chip 本身')

const plain = endOf(stateOf('/model 用力', { commands: ['model'] }))
assert.equal(
  selectAtomBefore(plain.apply(plain.tr.setSelection(TextSelection.create(plain.doc, 5))), null),
  false,
  '不紧跟 chip 时 Backspace 不拦截'
)

const renumberBefore = stateOf('@图1 和 @图2 与 @图?', { imageCount: 2 })
const renumberTr = reconcileTextTransaction(renumberBefore, '@图? 和 @图1 与 @图?', { imageCount: 1 })
assert.ok(renumberTr, '删除附件后重编号生成文档事务')
assert.equal(docToText(renumberTr.doc), '@图? 和 @图1 与 @图?', '重编号后的文本逐字节等于目标文本')
const remaining = []
renumberTr.doc.descendants((node) => {
  if (node.type.name === 'mention') remaining.push(node.attrs.raw)
  return true
})
assert.deepEqual(remaining, ['@图1'], '重编号后只剩一个有效图片引用 chip')
assert.equal(countStructure(renumberTr.doc).atoms, 1, '断链 @图? 不建 chip')

const keepChipState = stateOf('/model 用力', { commands: ['model'] })
const appendTr = reconcileTextTransaction(keepChipState, '/model 用力解释', { commands: ['model'] })
assert.ok(appendTr, '外部追加文本能就地应用')
assert.equal(docToText(appendTr.doc), '/model 用力解释', '就地追加后文本正确')
assert.equal(countStructure(appendTr.doc).atoms, 1, '就地追加保留原有 chip')

const markedDoc = composerSchema.node('doc', null, [
  composerSchema.node('paragraph', null, [
    composerSchema.text('x', [composerSchema.marks.code.create()]),
    composerSchema.text(' 结束')
  ])
])
const markedState = EditorState.create({ doc: markedDoc, selection: TextSelection.create(markedDoc, 3) })
const markAppend = reconcileTextTransaction(markedState, `${docToText(markedDoc)}了`)
assert.ok(markAppend, '带 mark 的文本外部追加能就地应用')
assert.equal(docToText(markAppend.doc), '`x` 结束了', '就地追加不改写 mark 写回的文本')
assert.ok(markAppend.doc.rangeHasMark(1, 2, composerSchema.marks.code), '就地追加不清掉已有的行内码 mark')

const tickState = plainStateOf('`code')
const tickTr = inputRuleTransaction(tickState, tickState.selection.from, tickState.selection.to, '`')
assert.ok(tickTr, '行内码规则生成事务')
assert.equal(docToText(tickTr.doc), '`code`', '行内码规则写回同一个反引号')
assert.ok(tickTr.doc.rangeHasMark(1, 5, composerSchema.marks.code), '行内区间带上行内码 mark')

const strikeState = plainStateOf('~~删除~')
const strikeTr = inputRuleTransaction(strikeState, strikeState.selection.from, strikeState.selection.to, '~')
assert.ok(strikeTr, '删除线规则生成事务')
assert.equal(docToText(strikeTr.doc), '~~删除~~', '删除线规则写回同一对 ~~')
assert.ok(strikeTr.doc.rangeHasMark(1, 3, composerSchema.marks.strike), '区间带上删除线 mark')

const urlState = plainStateOf('看 https://example.com/a')
const urlTr = inputRuleTransaction(urlState, urlState.selection.from, urlState.selection.to, ' ')
assert.ok(urlTr, 'URL 规则生成事务')
assert.equal(docToText(urlTr.doc), '看 https://example.com/a ', 'URL 规则不改写文本，只补上输入的空格')
assert.ok(urlTr.doc.rangeHasMark(3, 26, composerSchema.marks.link), 'URL 区间带上链接 mark')

const urlInCodeBlock = (() => {
  const doc = composerSchema.node('doc', null, [
    composerSchema.node('paragraph', null, []),
    composerSchema.node('code_block', { language: '' }, composerSchema.text('https://example.com/a'))
  ])
  const state = EditorState.create({ doc, selection: TextSelection.create(doc, doc.content.size - 1) })
  return inputRuleTransaction(state, state.selection.from, state.selection.to, ' ')
})()
assert.ok(urlInCodeBlock === null, '代码块里不做 URL 规则')

const backtickInCode = (() => {
  const doc = composerSchema.node('doc', null, [
    composerSchema.node('code_block', { language: '' }, composerSchema.text('`x'))
  ])
  const state = EditorState.create({ doc, selection: TextSelection.create(doc, doc.content.size - 1) })
  return inputRuleTransaction(state, state.selection.from, state.selection.to, '`')
})()
assert.ok(backtickInCode === null, '代码块里不触发行内码规则')

const plainFenceState = (() => {
  const doc = composerSchema.node('doc', null, [
    composerSchema.node('paragraph', null, inlineNodesForText('a\n```js\nconst a = 1\n```\nb'))
  ])
  return EditorState.create({ doc, selection: TextSelection.create(doc, doc.content.size - 1) })
})()
const fenceTr = fenceTransaction(plainFenceState, {})
assert.ok(fenceTr, '收尾围栏写完后合成代码块')
assert.equal(docToText(fenceTr.doc), 'a\n```js\nconst a = 1\n```\nb', '围栏合成不改写文本')
assert.equal(countStructure(fenceTr.doc).code, 1, '文本里出现一个代码块')
assert.equal(
  nodeAt(fenceTr.doc, (node) => node.type.name === 'code_block')?.textContent,
  'const a = 1',
  '代码块内容是围栏之间的行'
)

const openFenceState = (() => {
  const doc = composerSchema.node('doc', null, [
    composerSchema.node('paragraph', null, inlineNodesForText('```js\nconst a = 1'))
  ])
  return EditorState.create({ doc, selection: TextSelection.create(doc, doc.content.size - 1) })
})()
assert.ok(fenceTransaction(openFenceState, {}) === null, '未收尾的围栏不合成代码块')

const emptyState = stateOf('')
assert.ok(structureTransaction(emptyState, { commands: ['model'] }) === null, '没有可识别的原子时不重建文档')

const chipRebuildState = stateOf('/model 用力', { commands: ['model'] })
assert.ok(structureTransaction(chipRebuildState, { commands: ['model'] }) === null, '结构已最新时不重复重建')
const plainChip = stateOf('/model 用力')
const rebuilt = structureTransaction(plainChip, { commands: ['model'] })
assert.ok(rebuilt, '上下文到位后把命令文本重建为 chip')
assert.equal(docToText(rebuilt.doc), '/model 用力', '重建 chip 不改文本')

const inBlock = (() => {
  const doc = composerSchema.node('doc', null, [
    composerSchema.node('code_block', { language: 'js' }, composerSchema.text('const a = 1'))
  ])
  return EditorState.create({ doc, selection: TextSelection.create(doc, doc.content.size - 1) })
})()
const caretOffset = textOffsetForPosition(inBlock.doc, inBlock.selection.from)
const newlineTr = codeBlockEnterTransaction(inBlock)
assert.ok(newlineTr, '代码块内回车生成换行事务')
assert.equal(
  docToText(newlineTr.doc),
  `${docToText(inBlock.doc).slice(0, caretOffset)}\n${docToText(inBlock.doc).slice(caretOffset)}`,
  '代码块内回车只加一个换行，不改写围栏'
)

const exitTr = codeBlockEnterTransaction(inBlock.apply(newlineTr))
assert.ok(exitTr, '空行上回车生成退出事务')
assert.equal(docToText(exitTr.doc), `${docToText(newlineTr.doc)}\n`, '退出代码块后文本只多一个换行')
assert.equal(exitTr.doc.lastChild.type.name, 'paragraph', '退出后光标所在是普通段落')

console.log('输入框文档层：原子插入、整块选中、重编号、就地校正、四项输入规则与围栏合成检查通过')

const markedFenceDoc = composerSchema.node('doc', null, [
  composerSchema.node('paragraph', null, [
    composerSchema.text('x', [composerSchema.marks.code.create()]),
    composerSchema.nodes.hard_break.create(),
    composerSchema.text('```js'),
    composerSchema.nodes.hard_break.create(),
    composerSchema.text('const a = 1'),
    composerSchema.nodes.hard_break.create(),
    composerSchema.text('```')
  ])
])
const markedFenceText = docToText(markedFenceDoc)
const markedFenceState = EditorState.create({ doc: markedFenceDoc, selection: TextSelection.create(markedFenceDoc, 1) })
const markedFenceTr = fenceTransaction(markedFenceState, {})
assert.ok(markedFenceTr, '带行内码的草稿也能合成代码块')
assert.equal(docToText(markedFenceTr.doc), markedFenceText, '合成代码块不改文本（含行内码标记）')
assert.ok(markedFenceTr.doc.rangeHasMark(1, 2, composerSchema.marks.code), '合成代码块后行内码标记保留')
assert.equal(countStructure(markedFenceTr.doc).code, 1, '带标记时仍生成一个代码块')

const rebuiltMarks = textToDoc('`x` ~~s~~ https://e.com 结束')
assert.equal(docToText(rebuiltMarks), '`x` ~~s~~ https://e.com 结束', '重建文档时按同一套写法还原三个 mark，文本不变')
assert.ok(rebuiltMarks.rangeHasMark(1, 2, composerSchema.marks.code), '重建后行内码 mark 落在同一段文本上')
assert.ok(rebuiltMarks.rangeHasMark(3, 4, composerSchema.marks.strike), '重建后删除线 mark 落在同一段文本上')
assert.ok(
  rebuiltMarks.rangeHasMark(5, 18, composerSchema.marks.link),
  '重建后链接 mark 落在同一段 URL 上'
)

console.log('输入框文档层 · 围栏与标记协作检查通过')

const parenState = plainStateOf('https://example.com/a(b)')
const parenTr = inputRuleTransaction(parenState, parenState.selection.from, parenState.selection.from, ' ')
assert.ok(parenTr, '含括号的 URL 打空格后自动成链接')
assert.equal(docToText(parenTr.doc), 'https://example.com/a(b) ', '加链接只多一个空格，文本逐字节不变')
assert.ok(parenTr.doc.rangeHasMark(1, 26, composerSchema.marks.link), '链接标记覆盖含括号的整条 URL')

const parenTailState = plainStateOf('(see https://example.com/a(b))')
const parenTailTr = inputRuleTransaction(parenTailState, parenTailState.selection.from, parenTailState.selection.from, ' ')
assert.ok(parenTailTr, '括号包裹的含括号 URL 也能成链接')
assert.equal(docToText(parenTailTr.doc), '(see https://example.com/a(b)) ', '外层括号不进链接，文本不变')

const unbalancedState = plainStateOf('https://example.com/a)b')
assert.equal(
  inputRuleTransaction(unbalancedState, unbalancedState.selection.from, unbalancedState.selection.from, ' '),
  null,
  '括号不配平的 URL 不自动成链接（文本保持纯文本）'
)

const plainCodeState = plainStateOf('x')
assert.equal(caretInCode(plainCodeState), false, '普通段落光标不在代码里')
const inlineCodeDoc = composerSchema.node('doc', null, [
  composerSchema.node('paragraph', null, [composerSchema.text('xy', [composerSchema.marks.code.create()])])
])
const inlineCodeState = EditorState.create({
  doc: inlineCodeDoc,
  selection: TextSelection.create(inlineCodeDoc, 2)
})
assert.equal(caretInCode(inlineCodeState), true, '行内码里光标判为代码')
const codeBlockDoc = composerSchema.node('doc', null, [
  composerSchema.nodes.code_block.create(null, composerSchema.text('a'))
])
const codeBlockState = EditorState.create({
  doc: codeBlockDoc,
  selection: TextSelection.create(codeBlockDoc, 2)
})
assert.equal(caretInCode(codeBlockState), true, '代码块里光标判为代码')

console.log('输入框文档层 · 含括号 URL 自动链接与代码内判据检查通过')
