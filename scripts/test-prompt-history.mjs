import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(
  new URL('../src/renderer/src/features/composer/prompt-history.ts', import.meta.url)
)
const result = await build({ entryPoints: [source], bundle: true, write: false, platform: 'node', format: 'esm' })
const lib = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
const { INITIAL_PROMPT_HISTORY, humanPrompts, isEmptyComposerText, promptHistoryStep, queueRecallTarget } = lib

const PROMPTS = ['第一条', '第二条\n第二行', '第三条']

const step = (previous, input) =>
  promptHistoryStep(previous, {
    resetKey: 'sess-a',
    key: 'ArrowUp',
    empty: true,
    caretAtStart: true,
    caretAtEnd: true,
    text: '',
    prompts: PROMPTS,
    ...input
  })

assert.equal(isEmptyComposerText(''), true, '空文本算空输入')
assert.equal(isEmptyComposerText('\n\n'), true, '只有换行也算空输入')
assert.equal(isEmptyComposerText(' '), false, '空格不算空输入')

assert.deepEqual(
  humanPrompts([
    { role: 'user', text: '问题一' },
    { role: 'assistant', text: '回答' },
    { role: 'bash', text: '!ls' },
    { role: 'user', text: '问题二' },
    { role: 'user', text: '', note: { kind: 'branchSummary' } },
    { role: 'user', text: '提问卡', question: true },
    { role: 'user', text: '' }
  ]),
  ['问题一', '问题二'],
  '历史只取当前会话的人类用户消息，跳过助手、bash、note、提问卡与空文本'
)

assert.equal(queueRecallTarget({}), null, '队列为空时没有取回目标')
assert.deepEqual(
  queueRecallTarget({ followUp: [{ id: 'q1' }, { id: 'q2' }], pending: [{ id: 'p1' }] }),
  { kind: 'queued', id: 'q2' },
  '队列非空时先取最新一条排队消息'
)
assert.deepEqual(
  queueRecallTarget({ followUp: [], pending: [{ id: 'p1' }, { id: 'p2' }] }),
  { kind: 'pending', id: 'p2' },
  '没有排队消息时取最新一条暂持发送'
)

const first = step(INITIAL_PROMPT_HISTORY, {})
assert.equal(first.action, 'recall', '空输入 ↑ 取回最新一条用户消息')
assert.equal(first.text, '第三条', '取回的是最新一条')
assert.deepEqual(first.nav, { index: 3, total: 3, hasDraft: false }, '播报位置从 3/3 开始')

const second = step(first.state, { text: '第三条', empty: false, caretAtStart: false })
assert.equal(second.text, '第二条\n第二行', '连续 ↑ 向更早移动')
assert.deepEqual(second.nav, { index: 2, total: 3, hasDraft: false })

const third = step(second.state, { text: '第二条\n第二行' })
assert.equal(third.text, '第一条', '继续 ↑ 到最早一条')
assert.equal(step(third.state, { text: '第一条', caretAtStart: false }).action, 'swallow', '最早一条再 ↑ 不先移动光标')
assert.equal(
  step(second.state, { text: '第二条\n第二行', empty: false, caretAtStart: false, caretAtEnd: false }).text,
  '第一条',
  '多行历史中 ↑ 一次切换，不先移动光标'
)
assert.equal(step(third.state, { text: '第一条' }).action, 'swallow', '最早一条再 ↑ 只吞键不移动')
assert.equal(step(third.state, { text: '第一条' }).preventDefault, undefined, '吞键结果不带 preventDefault 字段')

const back = step(third.state, { key: 'ArrowDown', text: '第一条', empty: false, caretAtEnd: false })
assert.equal(back.text, '第二条\n第二行', '↓ 回到较新一条')
assert.deepEqual(back.nav, { index: 2, total: 3, hasDraft: false })

const newest = step(back.state, { key: 'ArrowDown', text: '第二条\n第二行' })
assert.equal(newest.text, '第三条', '↓ 回到最新一条')

const restore = step(newest.state, { key: 'ArrowDown', text: '第三条', empty: false, caretAtEnd: false })
assert.equal(restore.action, 'restore', '↓ 越过最新一条时恢复草稿')
assert.equal(restore.text, '', '草稿是进入历史前的空文本')
assert.equal(restore.nav, null, '恢复草稿后不再播报历史位置')

const newlineDraft = step(INITIAL_PROMPT_HISTORY, { text: '\n' })
assert.equal(newlineDraft.action, 'recall', '只有换行时也能进入历史')
assert.equal(step(newlineDraft.state, { key: 'ArrowDown', text: '第三条' }).text, '\n', '恢复的草稿保留原文本')

assert.equal(
  step(INITIAL_PROMPT_HISTORY, { empty: false, text: '半句草稿' }).action,
  'none',
  '输入框非空时 ↑ 不进历史（照常走光标）'
)
assert.equal(
  step(INITIAL_PROMPT_HISTORY, { key: 'ArrowDown', text: '' }).action,
  'none',
  '没有在历史里时 ↓ 不动作'
)
assert.equal(
  step(INITIAL_PROMPT_HISTORY, { caretAtEnd: false, text: '第三条' , key: 'ArrowDown' }).action,
  'none',
  '↓ 要求光标在文末'
)
assert.equal(
  step(INITIAL_PROMPT_HISTORY, { caretAtStart: false }).action,
  'none',
  '↑ 要求光标在文首'
)
assert.equal(step(INITIAL_PROMPT_HISTORY, { shiftKey: true }).action, 'none', 'Shift+↑ 不进历史')
assert.equal(step(INITIAL_PROMPT_HISTORY, { ctrlKey: true }).action, 'none', 'Ctrl+↑ 不进历史')
assert.equal(step(INITIAL_PROMPT_HISTORY, { composing: true }).action, 'none', '输入法组合中不进历史')
assert.equal(step(INITIAL_PROMPT_HISTORY, { prompts: [] }).action, 'none', '没有历史消息时 ↑ 不动作')

const exit = step(first.state, { key: 'a', text: '第三条' })
assert.equal(exit.action, 'exit', '取回后打字退出历史浏览')
assert.equal(exit.nav, null, '退出后清掉播报')
const resumed = step(exit.state, { text: '第三条' })
assert.equal(resumed.text, '第二条\n第二行', '文本未改时 ↑ 仍可继续往更早走')

const edited = step(first.state, { text: '第三条（改过）', empty: false })
assert.equal(edited.action, 'none', '取回的文本被改过就不再当历史浏览')

const sent = step(first.state, { prompts: ['第一条', '第二条\n第二行', '第三条', '第四条'], text: '第三条', empty: false })
assert.equal(sent.action, 'none', '发出新消息后历史长度变化，先退出浏览')
assert.equal(step(sent.state, { text: '第三条', empty: false }).action, 'none', '长度变化后非空输入不继续取回')

const otherSession = step(first.state, { resetKey: 'sess-b', text: '' })
assert.equal(otherSession.text, '第三条', '换会话后从最新一条重新开始')

console.log('提示词历史：取回 / 连续 ↑↓ / 草稿恢复 / 退出与重置 检查通过')
