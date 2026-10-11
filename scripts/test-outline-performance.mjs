import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const scratch = await mkdtemp(join(tmpdir(), 'inkstone-outline-perf-'))
let checks = 0
const ok = (value, label) => { assert.ok(value, label); checks++ }
try {
  const compile = async (entry, name) => {
    const outfile = join(scratch, `${name}.mjs`)
    await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
    return import(pathToFileURL(outfile).href)
  }
  const { groupIntoTurns } = await compile('src/shared/turns.ts', 'turns')
  const { createOutlineProjector } = await compile('src/shared/outline-turns.ts', 'outline')
  // 优化前 ConversationOutline 的实际投影算法，作为逐字段等价性与测量对照。
  const before = (messages, streamingId) => {
    const all = groupIntoTurns(messages, streamingId)
    return all.filter(turn => turn.kind === 'user').map((user, index) => {
      const next = all[all.indexOf(user) + 1]
      const reply = next?.kind === 'assistant' ? next : null
      const textReply = all[all.indexOf(user) + 1]
      const assistant = textReply?.kind === 'assistant' ? textReply.response?.text ?? '' : ''
      return { user: user.msg.text, assistant, msgId: user.id, index,
        failed: !!reply && (reply.terminalReason === 'failed' || !!reply.error || reply.tools.some(call => call.status === 'error' && !call.cancelled)),
        timestamp: user.msg.timestamp, elapsedMs: reply?.elapsedMs, steps: reply?.tools.length ?? 0 }
    })
  }
  const fixture = [
    { id: 'orphan', role: 'assistant', text: '孤立回复' },
    { id: 'u1', role: 'user', text: '首问', timestamp: 100 },
    { id: 'a1', role: 'assistant', text: '解说', toolCalls: [{ id: 'c1', name: 'read', status: 'error', cancelled: true }] },
    { id: 'a2', role: 'assistant', text: '最终回答一\n\n最终回答二', elapsedMs: 123 },
    { id: 'bash', role: 'bash', text: '本机命令' },
    { id: 'u2', role: 'user', text: '第二问' },
    { id: 'a3', role: 'assistant', text: '', error: '失败', toolCalls: [{ id: 'c2', name: 'read', status: 'error' }] },
    { id: 'u3', role: 'user', text: '连续提问一' },
    { id: 'u4', role: 'user', text: '连续提问二' }
  ]
  const project = createOutlineProjector()
  const verify = (rows, live, label) => { assert.deepEqual(project(rows, live), before(rows, live), label); checks++ }
  verify(fixture, undefined, '孤立消息、bash、取消工具、失败和连续提问等价')
  verify(fixture, 'a3', '流式失败等价')
  const original = project(fixture)
  const extended = [...fixture, { id: 'live', role: 'assistant', text: '中文🖋️流式' }]
  verify(extended, 'live', '流式正文等价')
  const updated = project(extended, 'live')
  ok(original[0] === updated[0], '历史摘要引用复用')
  ok(original.at(-1) !== updated.at(-1), '当前回合摘要更新')
  verify(extended, undefined, '结束流式等价')
  verify(extended.map(m => m.id === 'a2' ? { ...m, text: '历史已编辑' } : m), undefined, '历史替换立即更新')
  verify(extended.slice(4), undefined, '裁掉开头后索引重排等价')
  verify([], undefined, '空会话等价')
  verify([{ id: 'u1', role: 'user', text: '另一个会话同id' }], undefined, '同id新引用不串缓存')

  const history = []
  for (let i = 0; i < 1000; i++) history.push(
    { id: `u${i}`, role: 'user', text: `Question ${i}` },
    { id: `a${i}`, role: 'assistant', text: (`Historical paragraph ${i}\n\n`).repeat(20) })
  history.push({ id: 'current-user', role: 'user', text: 'Stream current answer' })
  const runs = []
  for (let round = 0; round < 3; round++) {
    const after = createOutlineProjector()
    let previous = after([...history, { id: 'current', role: 'assistant', text: '' }], 'current')
    const times = { before: [], after: [] }
    let reused = 0
    for (let i = 0; i < 200; i++) {
      const rows = [...history, { id: 'current', role: 'assistant', text: 'Streaming text\n\n'.repeat(i + 1) }]
      let old, next
      // 交替顺序，避免总是让同一算法受益于热数据。
      for (const tag of i % 2 ? ['after', 'before'] : ['before', 'after']) {
        const start = performance.now()
        const result = tag === 'before' ? before(rows, 'current') : after(rows, 'current')
        times[tag].push(performance.now() - start)
        if (tag === 'before') old = result; else next = result
      }
      assert.deepEqual(next, old)
      if (previous[0] === next[0]) reused++
      previous = next
    }
    ok(reused === 200, '200次更新历史摘要引用保持稳定')
    const stats = values => { values.sort((a, b) => a - b); return { medianMs: values[100], p95Ms: values[190] } }
    runs.push({ round: round + 1, messages: 2002, updates: 200, before: stats(times.before), after: stats(times.after), stableHistoryReused: reused })
  }
  console.log(JSON.stringify({ checks, runs }, null, 2))
  if (process.env.YAN_OUTLINE_PERF_OUT) {
    const path = resolve(process.env.YAN_OUTLINE_PERF_OUT)
    await mkdir(resolve(path, '..'), { recursive: true })
    await writeFile(path, JSON.stringify({ checks, scope: '导航轨投影算法，合成2002条消息；非整体帧率或真实模型耗时', runs }, null, 2))
  }
} finally { await rm(scratch, { recursive: true, force: true }) }
