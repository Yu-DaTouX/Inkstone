import assert from 'node:assert/strict'
import { build } from 'esbuild'

const built = await build({
  stdin: {
    contents: `export * from './src/timeline'; export * from './src/messageBlocks'; export * from './src/format'`,
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

assert.equal(M.compactCount(999), '999')
assert.equal(M.compactCount(1234), '1.2k')
assert.equal(M.compactCount(45_600), '46k')
assert.equal(M.compactCount(2_400_000), '2.4M')
assert.equal(M.costText(0), '')
assert.equal(M.costText(0.004), '<$0.01')
assert.equal(M.costText(1.234), '$1.23')
assert.equal(M.costText(42.5), '$42.5')
assert.equal(M.contextRatio(undefined), null)
assert.equal(M.contextRatio({ percent: 50, tokens: null, window: 100 }), 0.5)
assert.equal(M.contextRatio({ percent: null, tokens: 30, window: 100 }), 0.3)
assert.equal(M.contextRatio({ percent: 180, tokens: null, window: 100 }), 1)

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
{
  const moved = '[砚宿主通知：会话已移动]\n这是宿主自动发出的通知，不是用户的新消息。会话已按用户批准移到新的工作目录：' + JSON.stringify('C:\\work\\new') + '\n先看新目录的 AGENTS.md'
  const timeline = M.makeTimeline([
    { id: 'u1', role: 'user', text: '开始' },
    { id: 'a1', role: 'assistant', text: '好' },
    { id: 'h1', role: 'user', text: moved, timestamp: 1 },
    { id: 'a2', role: 'assistant', text: '继续' },
    { id: 'h2', role: 'user', text: '[循环恢复 · 自动继续 1/1]\n上一轮因输出重复被安全中止。' },
    { id: 'h3', role: 'user', text: '额度已恢复，请从上一轮中断的地方继续完成任务。' },
    { id: 'h4', role: 'user', text: '[额度换号 · 自动继续 1/1]\n上一轮因订阅账号额度用完中断。' },
    { id: 's1', role: 'user', text: '<subagent-notification id="x" status="done">\n子代理完成\n</subagent-notification>' },
    { id: 'n1', role: 'note', text: '切换前讨论了两种方案', note: { kind: 'branchSummary' } }
  ])
  const notices = timeline.filter((entry) => entry.kind === 'notice')
  assert.deepEqual(notices.map((entry) => entry.key), ['h1', 'h2', 'h3', 'h4', 'n1'], '宿主续接与分支摘要都成为短提示，子代理通知仍隐藏')
  assert.ok(notices[0].label.includes('C:\\work\\new') && notices[0].icon === 'folder', '会话移动提示带新目录')
  assert.ok(notices[3].label.includes('换号'), '换号续跑显示为换号短提示')
  assert.equal(notices[4].body, '切换前讨论了两种方案', '分支摘要可展开看正文')
  assert.ok(!timeline.some((entry) => entry.kind === 'message' && /砚宿主通知|自动继续|额度已恢复|额度换号/.test(entry.message.text ?? '')), '宿主消息不再当用户气泡')
  assert.ok(M.SHOWN_ROLES.has('note'), 'note 角色会被显示')
}
{
  const terminal = ['[砚宿主通知：后台终端命令]', '终端：bash', '命令："npm run dev"', '状态：stopped（用户在后台任务里停止了这条命令）', '用时：3 秒'].join('\n')
  const timeline = M.makeTimeline([
    { id: 't1', role: 'user', text: terminal },
    { id: 'c1', role: 'user', text: '[Auto-continue 1/1] The previous model request failed with a temporary error (timeout, dropped connection or overload) and was not retried. Check the tool results so far.' },
    { id: 'c2', role: 'user', text: '[Auto-continue 1/1] The previous turn was stopped because its output started repeating. Do not repeat the looping content.' },
    { id: 'c3', role: 'user', text: '[Auto-continue 1/1] The subscription account ran out of quota and it has been restored. Check the tool results so far.' },
    { id: 'c4', role: 'user', text: '[Auto-continue 1/1] The subscription account ran out of quota and was switched to another account. Check the tool results so far.' },
    { id: 'w1', role: 'user', text: '【宿主提示】已到时间上限。不要再调用任何工具，立刻用已有的资料交出结论：先说已确认的结论，再说明哪些部分没来得及核实。' },
    { id: 'g1', role: 'user', text: '[砚宿主通知：以后新增的通知]\n正文' },
    { id: 'u1', role: 'user', text: '【宿主提示】是什么意思？' },
    { id: 'u2', role: 'user', text: '请解释 [砚宿主通知：会话已移动] 这一行' }
  ])
  const notices = timeline.filter((entry) => entry.kind === 'notice')
  assert.deepEqual(notices.map((entry) => entry.key), ['t1', 'c1', 'c2', 'c3', 'c4', 'w1', 'g1'], '后台终端、子代理续跑、收尾提示与未知宿主通知都收成短提示')
  assert.ok(notices[0].label.includes('npm run dev') && notices[0].label.includes('停止') && notices[0].icon === 'terminal', '后台终端提示带命令与状态')
  assert.ok(notices[1].label.includes('模型请求') && notices[2].label.includes('重复') && notices[3].label.includes('额度已恢复') && notices[4].label.includes('换号'), '子代理英文续跑句按原因归类')
  assert.equal(notices[5].label, '已要求收尾')
  assert.equal(notices[6].label, '以后新增的通知', '未知宿主通知显示方括号里的标题')
  assert.deepEqual(timeline.filter((entry) => entry.kind === 'message').map((entry) => entry.key), ['u1', 'u2'], '只是提到这些字样的用户消息照常显示')
}
{
  const summary = M.argSummary({ command: 'curl -H "Authorization: Bearer sk-live-123" https://api.x/y?token=abc && API_KEY=zzz run' })
  assert.ok(!/sk-live-123|token=abc|zzz/.test(summary) && summary.includes('***'), '工具摘要里的密钥被遮蔽')
}
{
  const blocks = M.parseMessageBlocks('前言\n| 项目 | 数值 |\n| --- | ---: |\n| A | 1 |\n| B \\| C | 2 |\n后记\n![图](https://x.y/a.png)\n- [x] 完成\n- [ ] 待办', false)
  const table = blocks.find((block) => block.kind === 'table')
  assert.deepEqual(table.rows, [['项目', '数值'], ['A', '1'], ['B | C', '2']], '表格按行列解析，转义竖线保留')
  assert.ok(blocks.some((block) => block.kind === 'image' && block.url === 'https://x.y/a.png'), '独占一行的图片成为图片块')
  assert.ok(blocks.some((block) => block.kind === 'text' && block.value === '后记'), '表格后的正文照常')
  assert.deepEqual(blocks.filter((block) => block.kind === 'list').map((block) => block.value), ['[x] 完成', '[ ] 待办'], '任务清单保留勾选标记交给渲染')
  assert.equal(M.parseMessageBlocks('| 只有一行 |', false)[0].kind, 'text', '没有分隔行时不当表格')
}
console.log('mobile-timeline: 时间线复用与消息块解析通过')
