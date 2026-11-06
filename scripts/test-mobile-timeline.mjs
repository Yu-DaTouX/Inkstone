import assert from 'node:assert/strict'
import { build } from 'esbuild'

const built = await build({
  stdin: {
    contents: `export * from './src/timeline'; export * from './src/messageBlocks'`,
    resolveDir: 'mobile',
    loader: 'ts'
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false
})
const M = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

const make = (count) => {
  const out = []
  for (let turn = 0; turn < count; turn++) {
    out.push({ id: `u${turn}`, role: 'user', text: `问题 ${turn}`, timestamp: turn * 10 })
    out.push({ id: `a${turn}-1`, role: 'assistant', thinking: '想一想', toolCalls: [{ id: `t${turn}`, name: 'bash', status: 'done', args: { command: 'ls' }, output: 'x'.repeat(200) }], timestamp: turn * 10 + 1 })
    out.push({ id: `a${turn}-2`, role: 'assistant', text: `回答 ${turn}\n\n- 一\n- 二\n\n\`\`\`ts\nconst a = ${turn}\n\`\`\``, timestamp: turn * 10 + 2 })
  }
  return out
}

const clone = (value) => JSON.parse(JSON.stringify(value))
const messages = make(30)
const first = M.makeTimeline(messages)
assert.equal(first.length, 90)
assert.ok(first.every((entry) => entry.sources.length >= 1), '每个时间线条目记录来源消息')

const fresh = clone(messages)
const reused = M.reuseMessages(messages, fresh)
assert.equal(reused, messages, '内容完全相同的刷新直接复用旧数组')

const grown = clone(messages)
grown.push({ id: 'u30', role: 'user', text: '新问题' })
const merged = M.reuseMessages(messages, grown)
assert.notEqual(merged, messages)
assert.equal(merged[10], messages[10], '未变化的消息保持同一对象')
assert.equal(merged.length, 91)

const edited = clone(messages)
edited[88].text += '（流式追加）'
const mergedEdit = M.reuseMessages(messages, edited)
assert.notEqual(mergedEdit[88], messages[88])
assert.equal(mergedEdit[87], messages[87])

const stable1 = M.stabilizeTimeline(first, M.makeTimeline(merged))
assert.equal(stable1.length, 91)
let same = 0
for (let i = 0; i < first.length; i++) if (stable1[i] === first[i]) same++
assert.equal(same, 90, '追加一条消息后原有 90 个条目对象全部复用')

const stable2 = M.stabilizeTimeline(first, M.makeTimeline(mergedEdit))
const rerendered = stable2.filter((entry, i) => entry !== first[i]).length
assert.equal(rerendered, 1, '只有被改动的那条回复需要重绘')

const noChange = M.stabilizeTimeline(first, M.makeTimeline(reused))
assert.equal(noChange, first, '没有变化时返回同一个时间线数组')

const A = M.parseMessageBlocks('# 标题\n\n- 一\n\n```ts\nx\n```', false)
assert.deepEqual(A.map((block) => block.kind), ['heading', 'text', 'list', 'text', 'code'])
const folded = M.parseMessageBlocks('a'.repeat(9000), true)
assert.ok(folded.at(-1).value.endsWith('…') || folded.at(-1).value.length < 9000, '折叠只解析前 8000 字')

const bench = (label, run, rounds = 200) => {
  run()
  const times = []
  for (let r = 0; r < 5; r++) {
    const start = performance.now()
    for (let i = 0; i < rounds; i++) run()
    times.push((performance.now() - start) / rounds)
  }
  times.sort((a, b) => a - b)
  return { label, ms: Number(times[2].toFixed(3)) }
}

const big = make(30)
const results = [
  bench('时间线构建（90 条消息）', () => M.makeTimeline(big)),
  bench('复用检测（90 条，内容未变）', () => M.reuseMessages(big, clone(big)), 50),
  bench('正文解析（30 条）', () => { for (const message of big) if (message.text) M.parseMessageBlocks(message.text, false) })
]
if (process.env.MOBILE_BENCH) console.log(JSON.stringify(results))
console.log('mobile-timeline: 时间线复用与消息块解析通过')
