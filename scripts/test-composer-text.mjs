import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../src/renderer/src/features/composer/composer-text.ts', import.meta.url))
const result = await build({ entryPoints: [source], bundle: true, write: false, platform: 'node', format: 'esm' })
const {
  clampSelection,
  caretSelection,
  hasComposerText,
  replaceTextRange,
  insertTextAt,
  appendBlock,
  prependBlock,
  composerSchema,
  docToText,
  textToDoc,
  inlineNodesForText,
  positionForTextOffset,
  textOffsetForPosition,
  resolveTextSelection
} = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)

assert.deepEqual(clampSelection('abc', { start: -3, end: 9 }), { start: 0, end: 3 }, '范围夹到文本内')
assert.deepEqual(clampSelection('abc', { start: 2, end: 0 }), { start: 0, end: 2 }, '反向范围归一为正向')
assert.deepEqual(caretSelection('abc', 99), { start: 3, end: 3 }, '光标夹到末尾')
assert.deepEqual(caretSelection('abc', -1), { start: 0, end: 0 }, '负光标夹到开头')

assert.equal(hasComposerText(''), false, '空文本不算有内容')
assert.equal(hasComposerText(' \n\t '), false, '纯空白不算有内容')
assert.equal(hasComposerText(' a'), true, '带前导空格的非空文本算有内容')
assert.equal(hasComposerText('\u3000'), false, '全角空格不算有内容')

const empty = replaceTextRange('', { start: 0, end: 0 }, '你好')
assert.deepEqual(empty, { text: '你好', cursor: 2 }, '空文本插入后光标落在插入内容末尾')

const middle = replaceTextRange('abcd', { start: 2, end: 2 }, 'X')
assert.deepEqual(middle, { text: 'abXcd', cursor: 3 }, '中间插入不吞掉后续字符')

const selected = replaceTextRange('hello world', { start: 6, end: 11 }, 'there')
assert.deepEqual(selected, { text: 'hello there', cursor: 11 }, '替换选中区间')

const outside = replaceTextRange('abc', { start: 8, end: 12 }, 'Z')
assert.deepEqual(outside, { text: 'abcZ', cursor: 4 }, '越界区间按末尾处理')

const insertNothing = replaceTextRange('a\nb', { start: 1, end: 1 }, '')
assert.deepEqual(insertNothing, { text: 'a\nb', cursor: 1 }, '插入空串不改文本')

assert.deepEqual(insertTextAt('abcd', 1, 'Q'), { text: 'aQbcd', cursor: 2 }, '按光标位置插入')
assert.deepEqual(insertTextAt('abcd', { start: 1, end: 3 }, 'Q'), { text: 'aQd', cursor: 2 }, '按区间插入即替换')

const emoji = insertTextAt('a😀b', 3, '!')
assert.equal(emoji.text, 'a😀!b', '按 UTF-16 偏移插入，与 textarea 光标一致')
assert.equal(emoji.cursor, 4, '插入后光标按 UTF-16 前进')

assert.equal(appendBlock('', '新增'), '新增', '空文本追加不加换行')
assert.equal(appendBlock('原文', '新增'), '原文\n新增', '追加一行保留原文本')
assert.equal(prependBlock('', '排队'), '排队', '空文本前插不加换行')
assert.equal(prependBlock('原文', '排队'), '排队\n原文', '前插一行保留原文本')
assert.equal(appendBlock('a\r\nb', 'c'), 'a\r\nb\nc', '不改写原有换行符')

const roundTrip = appendBlock(prependBlock('正文', '队列'), '补充')
assert.equal(roundTrip, '队列\n正文\n补充', '前插与追加保持顺序')

const samples = [
  '',
  'a',
  'a\nb',
  'a\n\nb',
  '\na',
  'a\n',
  '\n\n\n',
  '  前导与尾随  ',
  'a\r\nb',
  'tab\there',
  '😀 与代理对 𝄞',
  '\u3000全角空格\u3000',
  '```js\nconst a = 1\n```',
  '多行\n第二行\n\n第四行\n'
]

for (const text of samples) {
  const doc = textToDoc(text)
  assert.equal(docToText(doc), text, `文本往返不变：${JSON.stringify(text.slice(0, 12))}`)
  assert.equal(docToText(textToDoc(docToText(doc))), text, '文本 → 文档 → 文本幂等')
  if (text.includes('```')) continue
  for (let offset = 0; offset <= text.length; offset++) {
    const position = positionForTextOffset(doc, offset)
    assert.equal(
      textOffsetForPosition(doc, position),
      offset,
      `偏移 ${offset} ↔ 文档位置 ${position} 往返：${JSON.stringify(text.slice(0, 12))}`
    )
  }
}

const longText = `${Array.from({ length: 500 }, (_, index) => `第 ${index} 行 trailing  `).join('\n')}\n\n尾行`
const longDoc = textToDoc(longText)
assert.equal(docToText(longDoc), longText, '500 行文本往返不变')
assert.equal(longDoc.childCount, 502, '每行一个段落，空行也是一个段落')
for (const offset of [0, 1, 2, longText.length - 1, longText.length]) {
  assert.equal(textOffsetForPosition(longDoc, positionForTextOffset(longDoc, offset)), offset, `长文本边界偏移 ${offset} 往返`)
}
const wideText = `${'长'.repeat(20000)}\n${'x'.repeat(20000)}`
assert.equal(docToText(textToDoc(wideText)), wideText, '超长单行文本往返不变')

const blankDoc = textToDoc('')
assert.equal(blankDoc.childCount, 1, '空文本仍有一个空段落')
assert.equal(blankDoc.textContent, '', '空段落没有文本节点')

const linesDoc = textToDoc('a\nb')
assert.equal(linesDoc.childCount, 2, '换行拆成两个段落')
assert.equal(linesDoc.child(0).type.name, 'paragraph', '块节点是段落')

const breaks = inlineNodesForText('a\n\nb')
assert.deepEqual(
  breaks.map((node) => (node.isText ? node.text : node.type.name)),
  ['a', 'hard_break', 'hard_break', 'b'],
  '粘贴多行文本时换行变 hard_break'
)

const withBreak = composerSchema.node('doc', null, [
  composerSchema.node('paragraph', null, [
    composerSchema.text('a'),
    composerSchema.nodes.hard_break.create(),
    composerSchema.text('b')
  ]),
  composerSchema.node('paragraph', null, composerSchema.text('c'))
])
assert.equal(docToText(withBreak), 'a\nb\nc', '段落内的 hard_break 也投影为换行')
assert.equal(textOffsetForPosition(withBreak, positionForTextOffset(withBreak, 2)), 2, 'hard_break 两侧的偏移可往返')

const selectionDoc = textToDoc('第一行\n\n第三行')
assert.deepEqual(resolveTextSelection(selectionDoc, { start: 0, end: 0 }), { start: 1, end: 1 }, '文首偏移落在首段内容起点')
const forward = resolveTextSelection(selectionDoc, { start: 2, end: 6 })
assert.ok(forward.start < forward.end, '跨行选区映射为正向文档区间')
assert.equal(textOffsetForPosition(selectionDoc, forward.start), 2, '选区起点可回读')
assert.equal(textOffsetForPosition(selectionDoc, forward.end), 6, '选区终点可回读')
const reversed = resolveTextSelection(selectionDoc, { start: 7, end: 6 })
assert.deepEqual(reversed, resolveTextSelection(selectionDoc, { start: 6, end: 7 }), '反向区间归一后与正向区间相同')

console.log('输入框纯文本层：范围夹取、插入、替换、整块前后拼接、空内容判据与文档投影往返检查通过')

const fenceText = '```js\nconst a = 1\n```'
const fenceDoc = textToDoc(fenceText)
assert.equal(fenceDoc.childCount, 1, '围栏文本合成一个代码块')
assert.equal(fenceDoc.child(0).type.name, 'code_block', '围栏行成为代码块')
assert.equal(fenceDoc.child(0).attrs.language, 'js', '代码块保留围栏语言')
assert.equal(docToText(fenceDoc), fenceText, '围栏往返逐字节不变')
assert.equal(textOffsetForPosition(fenceDoc, positionForTextOffset(fenceDoc, 7)), 7, '代码块内容里的偏移可往返')
assert.equal(textOffsetForPosition(fenceDoc, positionForTextOffset(fenceDoc, fenceText.length - 4)), fenceText.length - 4, '代码块末尾内容偏移可往返')
assert.equal(textOffsetForPosition(fenceDoc, positionForTextOffset(fenceDoc, 1)), 6, '围栏标记内的偏移映射到代码块内容起点')

const fenceAround = 'a\n```py\nb = 1\n```\nc'
const aroundDoc = textToDoc(fenceAround)
assert.equal(aroundDoc.childCount, 3, '代码块前后各保留一个段落')
assert.equal(aroundDoc.child(1).type.name, 'code_block', '中间块是代码块')
assert.equal(docToText(aroundDoc), fenceAround, '代码块前后行往返逐字节不变')

const noClose = '```js\nconst a = 1'
assert.equal(docToText(textToDoc(noClose)), noClose, '缺收尾围栏时保留纯段落')
assert.equal(textToDoc(noClose).child(0).type.name, 'paragraph', '缺收尾围栏不建代码块')

const badLanguage = '```www.example.com\nx\n```'
assert.equal(docToText(textToDoc(badLanguage)), badLanguage, '语言名不可写回时保留纯段落')
assert.equal(textToDoc(badLanguage).child(0).type.name, 'paragraph', '语言名不能写回时不建代码块')

const chipDoc = textToDoc('/model 用力解释', { commands: ['model'] })
assert.equal(chipDoc.child(0).child(0).type.name, 'command_chip', '已知命令转成命令 chip')
assert.equal(docToText(chipDoc), '/model 用力解释', '命令 chip 序列化不加分隔空格')
assert.equal(chipDoc.child(0).child(1).text, ' 用力解释', 'chip 之后的内容按原文保留')

const unknownChip = textToDoc('/nope 用力解释', { commands: ['model'] })
assert.equal(unknownChip.child(0).child(0).type.name, 'text', '未知命令保持纯文本')
assert.equal(docToText(unknownChip), '/nope 用力解释', '未知命令文本不变')

const midChip = textToDoc('叫声 /model', { commands: ['model'] })
assert.equal(midChip.child(0).child(0).type.name, 'text', '行中斜杠不转 chip')

const mentionDoc = textToDoc('@src/a.ts 看看', { mentions: ['src/a.ts'] })
assert.equal(mentionDoc.child(0).child(0).type.name, 'mention', '已知路径转成提及 chip')
assert.equal(docToText(mentionDoc), '@src/a.ts 看看', '提及 chip 序列化保留原文')

const quotedDoc = textToDoc('@"my dir/a b.ts" 看看', { mentions: ['my dir/a b.ts'] })
assert.equal(quotedDoc.child(0).child(0).type.name, 'mention', '带空格路径的引号写法转成提及 chip')
assert.equal(docToText(quotedDoc), '@"my dir/a b.ts" 看看', '提及 chip 保留引号，往返逐字节不变')
assert.equal(quotedDoc.child(0).child(0).attrs.path, 'my dir/a b.ts', '提及 chip 存去引号的路径')

const unknownMention = textToDoc('@unknown/a.ts', { mentions: ['src/a.ts'] })
assert.equal(unknownMention.child(0).child(0).type.name, 'text', '未知路径保持纯文本')

const imagesDoc = textToDoc('@图1 和 @图2', { imageCount: 2 })
assert.equal(imagesDoc.child(0).child(0).type.name, 'mention', '第一张图片引用转成 chip')
assert.equal(imagesDoc.child(0).child(2).type.name, 'mention', '第二张图片引用转成 chip')
assert.equal(docToText(imagesDoc), '@图1 和 @图2', '图片引用 chip 序列化保留原文')

const oneImage = textToDoc('@图1 和 @图2', { imageCount: 1 })
assert.equal(oneImage.child(0).childCount, 2, '附件不够时只有第一张成为 chip')
assert.equal(oneImage.child(0).child(1).text.includes('@图2'), true, '附件不够时第二张留作注释文本')
assert.equal(docToText(oneImage), '@图1 和 @图2', '附件不够时文本不变')

const brokenRef = textToDoc('@图? 已删除', { imageCount: 3 })
assert.equal(brokenRef.child(0).child(0).type.name, 'text', '断链 @图? 保持纯文本')

const markedDoc = composerSchema.node('doc', null, [
  composerSchema.node('paragraph', null, [
    composerSchema.text('x', [composerSchema.marks.code.create()]),
    composerSchema.text(' '),
    composerSchema.text('s', [composerSchema.marks.strike.create()]),
    composerSchema.text(' '),
    composerSchema.text('https://e.com', [composerSchema.marks.link.create({ href: 'https://e.com' })])
  ])
])
assert.equal(docToText(markedDoc), '`x` ~~s~~ https://e.com', '三个 mark 按原文写回投影')
assert.equal(textOffsetForPosition(markedDoc, positionForTextOffset(markedDoc, 1)), 1, '行内码里的偏移可往返')
assert.equal(textOffsetForPosition(markedDoc, positionForTextOffset(markedDoc, 15)), 15, '链接文本里的偏移可往返')
for (const adjacent of ['`a``b`', '~~a~~~~b~~', '`图``)`.)', '~~ ~~~~@src/x.ts~~', '/model```)``https://x.io/a(b)) `']) {
  assert.equal(docToText(textToDoc(adjacent, { commands: ['model'], mentions: ['src/x.ts'] })), adjacent, `相邻同类标记不合并丢字：${adjacent}`)
}
