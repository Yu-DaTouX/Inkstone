import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../src/renderer/src/features/composer/prompt-stash.ts', import.meta.url))
const result = await build({ entryPoints: [source], bundle: true, write: false, platform: 'node', format: 'esm' })
const {
  PROMPT_STASH_LIMIT,
  PROMPT_STASH_SNIPPET_MAX,
  stashSnippet,
  stashHasContent,
  createPromptStashEntry,
  pushPromptStash,
  removePromptStash,
  swapPromptStash,
  stashAge,
  parsePromptStash,
  isPromptStashShortcut
} = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)

const image = (id) => ({
  id,
  name: `${id}.png`,
  mimeType: 'image/png',
  size: 8,
  data: 'A'.repeat(8),
  preview: 'A'.repeat(8),
  kind: 'image'
})
const fileRef = (id) => ({
  id,
  name: 'README.md',
  mimeType: 'text/markdown',
  size: 10,
  data: '',
  preview: '',
  kind: 'file',
  path: 'E:/repo/README.md'
})

const entry = (id, text, at = 1_000, attachments = []) => ({
  id,
  text,
  attachments,
  createdAt: at,
  sessionKey: 'sess-a'
})

assert.equal(stashHasContent('', []), false, '空文本、无附件不算内容')
assert.equal(stashHasContent('  \n\t', []), false, '只有空白不算内容')
assert.equal(stashHasContent('  ', [image('i1')]), true, '只有图片也算内容')
assert.equal(stashHasContent('hi', []), true, '文字算内容')

assert.equal(stashSnippet(''), '', '空文本片段为空')
assert.equal(stashSnippet('  第一行\n\n第二行\t第三行  '), '第一行 第二行 第三行', '片段折叠空白并去掉首尾空行')
const longText = '字'.repeat(PROMPT_STASH_SNIPPET_MAX + 20)
const snippet = stashSnippet(longText)
assert.equal(snippet.length, PROMPT_STASH_SNIPPET_MAX + 1, '超长片段截断到 90 字并加省略号')
assert.equal(snippet.endsWith('…'), true, '截断后带省略号')
assert.equal(stashSnippet('字'.repeat(PROMPT_STASH_SNIPPET_MAX)), '字'.repeat(PROMPT_STASH_SNIPPET_MAX), '恰好 90 字不截断')

assert.equal(createPromptStashEntry({ text: '   ', attachments: [] }, 1), null, '没有内容不生成条目')

const created = createPromptStashEntry({ text: '提问', attachments: [image('i1'), fileRef('f1')], sessionKey: 'sess-b' }, 1_234, 'ps-fixed')
assert.equal(created.id, 'ps-fixed', '可指定 id')
assert.equal(created.createdAt, 1_234, '记录创建时间')
assert.equal(created.sessionKey, 'sess-b', '记录来源会话')
assert.equal(created.attachments.length, 2, '保留图片与文件引用')

const bigImage = { ...image('i2'), data: 'A'.repeat(1_200_000), preview: 'A'.repeat(1_200_000) }
const trimmed = createPromptStashEntry({ text: '带大图', attachments: [bigImage, fileRef('f2')] }, 1, 'ps-big')
assert.deepEqual(trimmed.attachments.map((item) => item.id), ['f2'], '超出体积预算的图片被裁掉，文件引用保留')

const many = []
for (let i = 0; i < PROMPT_STASH_LIMIT + 5; i++) many.push(entry(`id-${i}`, `第 ${i} 条`, 10_000 - i))
const capped = pushPromptStash(many, entry('newest', '最新', 9_999))
assert.equal(capped.length, PROMPT_STASH_LIMIT, '超过上限后裁到 50 条')
assert.equal(capped[0].id, 'newest', '新的排在最前')
assert.equal(capped.some((item) => item.id === `id-${PROMPT_STASH_LIMIT + 4}`), false, '裁掉的是最旧的')
assert.equal(capped[capped.length - 1].id, `id-${PROMPT_STASH_LIMIT - 2}`, '保留较新的条目')
assert.equal(pushPromptStash(capped, entry('newest', '最新改', 9_999)).length, PROMPT_STASH_LIMIT, '同 id 不重复累加')

assert.deepEqual(removePromptStash([entry('a', '1'), entry('b', '2')], 'a').map((item) => item.id), ['b'], '删除指定条目')

const list = [entry('a', '第一条', 2_000), entry('b', '第二条', 1_000)]
const swapped = swapPromptStash(list, 'b', { text: '正在写的草稿', attachments: [image('i9')], sessionKey: 'sess-a' }, 5_000, { swapId: 'ps-swap' })
assert.equal(swapped.entry.id, 'b', '取回命中条目')
assert.equal(swapped.entry.text, '第二条', '取回的是该条目原文')
assert.deepEqual(swapped.list.map((item) => item.id), ['ps-swap', 'a'], '取回后该条目出栈')
assert.equal(swapped.list[0].text, '正在写的草稿', '当前输入先被暂存，排在最前')
assert.equal(swapped.list[0].attachments.length, 1, '交换时带着当前的图片')

const emptyCurrent = swapPromptStash(list, 'a', { text: '   ', attachments: [] }, 5_000)
assert.deepEqual(emptyCurrent.list.map((item) => item.id), ['b'], '当前输入为空时不产生新条目')

const missing = swapPromptStash(list, 'nope', { text: '草稿', attachments: [] }, 5_000)
assert.equal(missing.entry, null, '未知 id 取不到条目')
assert.deepEqual(missing.list.map((item) => item.id), ['a', 'b'], '未知 id 不改动列表')

assert.deepEqual(stashAge(10_000, 10_000), { unit: 'now' }, '同一时刻显示刚刚')
assert.deepEqual(stashAge(20_000, 10_000), { unit: 'now' }, '不到一分钟显示刚刚')
assert.deepEqual(stashAge(10_000 + 59_999, 10_000), { unit: 'now' }, '59 秒还是刚刚')
assert.deepEqual(stashAge(10_000 + 60_000, 10_000), { unit: 'minute', value: 1 }, '一分钟后按分钟')
assert.deepEqual(stashAge(10_000 + 59 * 60_000, 10_000), { unit: 'minute', value: 59 }, '一小时内按分钟')
assert.deepEqual(stashAge(10_000 + 60 * 60_000, 10_000), { unit: 'hour', value: 1 }, '一小时后按小时')
assert.deepEqual(stashAge(10_000 + 23 * 60 * 60_000, 10_000), { unit: 'hour', value: 23 }, '一天内按小时')
assert.deepEqual(stashAge(10_000 + 24 * 60 * 60_000, 10_000), { unit: 'day', value: 1 }, '一天后按天')
assert.deepEqual(stashAge(10_000 + 6 * 24 * 60 * 60_000, 10_000), { unit: 'day', value: 6 }, '六天还是按天')
assert.deepEqual(stashAge(10_000 + 8 * 24 * 60 * 60_000, 10_000), { unit: 'date' }, '超过一周改用日期')
assert.deepEqual(stashAge(1_000, 9_000), { unit: 'now' }, '时间在未来时按刚刚处理')

const parsed = parsePromptStash([
  entry('a', '正常'),
  entry('b', '   '),
  entry('c', '只有图片', 1_000, [image('i1')]),
  { id: '', text: '没有 id' },
  { id: 'd', text: '坏附件', attachments: [{ id: 'x' }] },
  entry('a', '重复 id'),
  null,
  'hello'
])
assert.deepEqual(parsed.map((item) => item.id), ['a', 'c', 'd'], '解析丢弃空内容、无 id、重复 id 与非法项')
assert.equal(parsed[2].attachments.length, 0, '非法附件被过滤')
assert.equal(parsePromptStash(null).length, 0, '非数组当作空列表')
assert.equal(parsePromptStash(Array.from({ length: 80 }, (_, i) => entry(`k${i}`, `t${i}`))).length, PROMPT_STASH_LIMIT, '解析时也守住上限')

assert.equal(isPromptStashShortcut({ key: 's', ctrlKey: true, shiftKey: true }), true, 'Ctrl+Shift+S 命中')
assert.equal(isPromptStashShortcut({ key: 'S', metaKey: true, shiftKey: true }), true, '⌘+Shift+S 命中')
assert.equal(isPromptStashShortcut({ key: 's', ctrlKey: true }), false, '缺 Shift 不命中')
assert.equal(isPromptStashShortcut({ key: 's', shiftKey: true }), false, '没有 Ctrl/⌘ 不命中')
assert.equal(isPromptStashShortcut({ key: 's', ctrlKey: true, shiftKey: true, altKey: true }), false, '带 Alt 不命中')
assert.equal(isPromptStashShortcut({ key: 's', ctrlKey: true, shiftKey: true, isComposing: true }), false, '输入法组字时不命中')
assert.equal(isPromptStashShortcut({ key: 'x', ctrlKey: true, shiftKey: true }), false, '其他键不命中')

console.log('✓ prompt-stash：片段截断、上限裁剪、取回交换、相对时间、解析与快捷键全部通过')
