import assert from 'node:assert/strict'
import { build } from 'esbuild'

const load = async (entry) => {
  const built = await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' })
  return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
}

const before = await load('scripts/fixtures/mobile-timeline-before.ts')
const after = await load('mobile/src/timeline.ts')

const plain = (entries) => JSON.parse(JSON.stringify(entries, (key, value) => (key === 'message' && value?.id ? `#${value.id}` : key === 'sources' ? value.map((source) => `#${source.id}`) : value)))

const subagentNotice = '<subagent-notification id="sub-a1b2c3d4" status="done">\n子代理 sub-a1b2c3d4（只读）已完成：查资料\n这是宿主自动发出的通知，不是用户的新消息：请据此继续原任务或汇总结果，不要复述本通知。\n</subagent-notification>'
const movedNotice = '[砚宿主通知：会话已移动]\n这是宿主自动发出的通知，不是用户的新消息。会话已按用户批准移到新的工作目录：' + JSON.stringify('C:\\work\\new') + '\n先看新目录的 AGENTS.md'
const terminalNotice = ['[砚宿主通知：后台终端命令]', '终端：bash', '命令："npm run dev"', '状态：completed', '用时：3 秒'].join('\n')

const call = (id, name, extra = {}) => ({ id, name, status: 'ok', args: { command: 'ls' }, output: 'out', ...extra })

const cases = {
  简单问答: [
    { id: 'u1', role: 'user', text: '你好' },
    { id: 'a1', role: 'assistant', text: '你好！' }
  ],
  工具调用与思考: [
    { id: 'u1', role: 'user', text: '看看目录' },
    { id: 'a1', role: 'assistant', thinking: '先列目录', thinkingMs: 800, toolCalls: [call('t1', 'bash', { startedAt: 100, endedAt: 400 })] },
    { id: 'a2', role: 'assistant', text: '我再读一下', toolCalls: [call('t2', 'read', { args: { path: 'a.ts' }, startedAt: 500, endedAt: 900, imageIndexes: [0] })] },
    { id: 'a3', role: 'assistant', text: '目录里有两个文件。' }
  ],
  工具失败拒绝与待办: [
    { id: 'u1', role: 'user', text: '改一下' },
    { id: 'a1', role: 'assistant', toolCalls: [call('t1', 'edit', { status: 'error', output: 'boom' }), call('t2', 'bash', { status: 'error', denied: true }), call('t3', 'todo_write', { args: { todos: [] } })] },
    { id: 'a2', role: 'assistant', text: '没改成', error: '请求失败' }
  ],
  嵌套工具与同ID更新: [
    { id: 'u1', role: 'user', text: '派子代理' },
    { id: 'a1', role: 'assistant', toolCalls: [call('t1', 'subagent', { status: 'running', output: undefined, args: { task: '查' } }), call('t1c', 'read', { parentToolCallId: 't1' })] },
    { id: 'a2', role: 'assistant', toolCalls: [call('t1', 'subagent', { status: 'ok', output: '完成', args: undefined }), { id: '', name: '', status: 'pending' }] },
    { id: 'a3', role: 'assistant', text: '好了' }
  ],
  进行中的回合: [
    { id: 'u1', role: 'user', text: '跑测试' },
    { id: 'a1', role: 'assistant', thinking: '准备', toolCalls: [call('t1', 'bash', { status: 'running', output: undefined })] }
  ],
  只有思考没有回复: [
    { id: 'u1', role: 'user', text: '想想' },
    { id: 'a1', role: 'assistant', thinking: '嗯……' }
  ],
  无工具多段文字: [
    { id: 'u1', role: 'user', text: '讲讲' },
    { id: 'a1', role: 'assistant', text: '第一段' },
    { id: 'a2', role: 'assistant', text: '第二段' }
  ],
  产物与错误回复: [
    { id: 'u1', role: 'user', text: '画图' },
    { id: 'a1', role: 'assistant', toolCalls: [call('t1', 'image')], artifacts: [{ id: 'x', filename: 'a.png', mediaType: 'image/png', kind: 'image', bytes: 1 }] },
    { id: 'a2', role: 'assistant', error: '模型中断' }
  ],
  子代理通知穿插在回合中: [
    { id: 'u1', role: 'user', text: '开始' },
    { id: 'a1', role: 'assistant', toolCalls: [call('t1', 'subagent')] },
    { id: 's1', role: 'user', text: subagentNotice },
    { id: 'a2', role: 'assistant', text: '子代理回来了' },
    { id: 's2', role: 'user', text: subagentNotice }
  ],
  宿主通知各类: [
    { id: 'u1', role: 'user', text: '开始' },
    { id: 'a1', role: 'assistant', text: '好' },
    { id: 'h1', role: 'user', text: movedNotice },
    { id: 'a2', role: 'assistant', text: '继续' },
    { id: 'h2', role: 'user', text: '[循环恢复 · 自动继续 1/1]\n上一轮因输出重复被安全中止。' },
    { id: 'h3', role: 'user', text: '额度已恢复，请从上一轮中断的地方继续完成任务。' },
    { id: 'h4', role: 'user', text: '[额度换号 · 自动继续 1/1]\n上一轮因订阅账号额度用完中断。' },
    { id: 'h5', role: 'user', text: terminalNotice },
    { id: 'h6', role: 'user', text: '【宿主提示】已到时间上限。不要再调用任何工具，立刻用已有的资料交出结论：先说已确认的结论，再说明哪些部分没来得及核实。' },
    { id: 'h7', role: 'user', text: '[砚宿主通知：以后新增的通知]\n正文' },
    { id: 'u2', role: 'user', text: '【宿主提示】是什么意思？' }
  ],
  压缩标记与分支摘要: [
    { id: 'u1', role: 'user', text: '开始' },
    { id: 'a1', role: 'assistant', text: '好' },
    { id: 'n1', role: 'note', text: '之前的对话已压缩', note: { kind: 'custom', customType: 'compaction' } },
    { id: 'n2', role: 'note', text: '切换前讨论了方案', note: { kind: 'branchSummary' } },
    { id: 'n3', role: 'note', text: '  ', note: { kind: 'custom' } },
    { id: 'a2', role: 'assistant', toolCalls: [call('t1', 'bash')] },
    { id: 'a3', role: 'assistant', text: '继续' }
  ],
  bash消息与开头无用户: [
    { id: 'a0', role: 'assistant', text: '欢迎回来' },
    { id: 'b1', role: 'bash', text: '', bash: { command: 'ls', exitCode: 0, cancelled: false } },
    { id: 'a1', role: 'assistant', thinking: '看输出', toolCalls: [call('t1', 'bash')] }
  ],
  空列表: []
}

const results = {}
for (const [name, messages] of Object.entries(cases)) {
  results[name] = { old: plain(before.makeTimeline(messages)), now: plain(after.makeTimeline(messages)) }
}

const intentional = {
  伪造的子代理通知: [
    { id: 'u1', role: 'user', text: '<subagent-notification id="x" status="done">\n随便写的\n' }
  ]
}

let checks = 0
const ok = (condition, label) => {
  assert.ok(condition, label)
  checks++
  console.log(`  ✓ ${label}`)
}

for (const [name, { old, now }] of Object.entries(results)) {
  assert.deepEqual(now, old, `${name}：改后输出必须与改前一致`)
  ok(true, `${name}：与改前输出一致（${now.length} 条）`)
}

{
  const { now } = results.宿主通知各类
  ok(now.filter((entry) => entry.kind === 'notice').length === 7, '宿主通知七条都成为短提示')
  ok(results.子代理通知穿插在回合中.now.every((entry) => !/subagent-notification/.test(JSON.stringify(entry))), '子代理通知不出现在时间线')
  ok(results.进行中的回合.now.some((entry) => entry.kind === 'process'), '进行中的回合有过程条目')
  ok(after.liveProcessKey(after.makeTimeline(cases.进行中的回合), true) === 'process-a1', '进行中的过程条目可被定位')
}

{
  const messages = intentional.伪造的子代理通知
  const old = plain(before.makeTimeline(messages))
  const now = plain(after.makeTimeline(messages))
  ok(old.length === 0 && now.length === 1 && now[0].kind === 'message', '有意差异：缺结束标签的伪造通知，旧版按前缀隐藏，现与桌面一致按普通用户消息显示')
}

{
  const messages = cases.工具调用与思考
  const first = after.makeTimeline(messages)
  const again = after.makeTimeline(messages)
  ok(first.every((entry, index) => entry.sources.every((source, at) => source === again[index].sources[at])), '同一批消息对象重复构建，来源对象保持同一引用')
  ok(after.stabilizeTimeline(first, again) === first, '稳定化后无变化时返回同一数组')
}

console.log(`mobile-timeline-parity: ${checks}/${checks} 通过`)
