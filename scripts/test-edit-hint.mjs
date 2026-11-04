import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closestRegion, editMismatchHint, resolveEditPath } from '../resources/pi-extensions/edit-hint.js'

const root = await mkdtemp(join(tmpdir(), 'yan-edit-hint-'))
try {
  const file = join(root, 'config.js')
  const lines = ['module.exports = {', '\tretry: 3,', '\ttimeout: 5000,', '\tname: "demo",', '}']
  for (let i = 0; i < 40; i++) lines.push(`// filler ${i}`)
  lines.push('function section4() {', "\treturn 'section-4'", '}')
  await writeFile(file, lines.join('\r\n'))
  const notFound = (index) => [{ type: 'text', text: index === undefined ? `Could not find the exact text in ${file}. The old text must match exactly including all whitespace and newlines.` : `Could not find edits[${index}] in ${file}. The oldText must match exactly including all whitespace and newlines.` }]

  const guessed = { toolName: 'edit', isError: true, input: { path: 'config.js', edits: [{ oldText: "function section4() {\n  return 'section-four-old'\n}", newText: 'x' }] }, content: notFound() }
  const hint = editMismatchHint(guessed, root)
  assert.ok(hint, '猜错了中间一行：给出最接近的现有片段')
  const added = hint.content.at(-1).text
  assert.equal(hint.content[0], guessed.content[0], '原错误保留在前面')
  assert.match(added, /lines 44-48/, '标出现有片段的行号范围')
  assert.match(added, /\treturn 'section-4'/, '片段带文件里真实的缩进与内容')
  assert.doesNotMatch(added, /^\s*\d+[:|]/m, '片段正文不带行号前缀，避免被抄进 oldText')
  assert.match(added, /2 of 3 oldText lines match/, '说明有几行能对上')

  const second = { toolName: 'edit', isError: true, input: { path: join(root, 'config.js'), edits: [{ oldText: '\tretry: 3,', newText: 'a' }, { oldText: '\ttimeout: 9000,\n\tname: "demo",', newText: 'b' }] }, content: notFound(1) }
  assert.match(editMismatchHint(second, '/elsewhere').content.at(-1).text, /timeout: 5000/, '多处编辑时按报错里的 edits[N] 取对应的 oldText')
  assert.match(editMismatchHint({ ...guessed, input: { ...guessed.input, path: `@${file}` } }, '/elsewhere').content.at(-1).text, /section-4/, '路径带 @ 前缀时按 pi 的方式解析')

  assert.equal(editMismatchHint({ ...guessed, input: { path: 'config.js', edits: [{ oldText: 'nothing like this at all', newText: 'x' }] } }, root), undefined, '一行都对不上时不追加')
  assert.equal(editMismatchHint({ ...guessed, isError: false }, root), undefined, '成功的 edit 不追加')
  assert.equal(editMismatchHint({ ...guessed, toolName: 'write' }, root), undefined, '其他工具不追加')
  assert.equal(editMismatchHint({ ...guessed, content: [{ type: 'text', text: 'Found 2 occurrences of the text' }] }, root), undefined, '不唯一的错误不追加')
  assert.equal(editMismatchHint({ ...guessed, input: { path: 'missing.js', edits: guessed.input.edits } }, root), undefined, '文件不存在时不追加')

  assert.equal(closestRegion('a\nb\nc', '\n\n'), null, '空白 oldText 不匹配')
  if (process.platform === 'win32') assert.equal(resolveEditPath('/c/x/a.ts', 'D:/w'), 'C:\\x\\a.ts', 'Git Bash 盘符路径换算')

  const big = Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n')
  await writeFile(join(root, 'big.txt'), big)
  const longOld = Array.from({ length: 200 }, (_, i) => `line ${i + 10} ${'x'.repeat(40)}`).join('\n') + '\nmissing tail'
  const longHint = editMismatchHint({ toolName: 'edit', isError: true, input: { path: 'big.txt', oldText: longOld, newText: '' }, content: notFound() }, root)
  assert.ok(longHint.content.at(-1).text.length < 4300, '长片段截断，不撑爆上下文')
  console.log('edit-hint: ok')
} finally {
  await rm(root, { recursive: true, force: true })
}
