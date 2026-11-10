import assert from 'node:assert/strict'
import { build } from '../node_modules/esbuild/lib/main.js'

const result = await build({
  entryPoints: ['src/main/ipc/session-command-target.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent'
})
const { abortBashFor, lastAssistantTextFor } = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
)

let pass = 0
function ok(condition, label, detail) {
  assert.ok(condition, `${label}${detail === undefined ? '' : ` ← ${JSON.stringify(detail)}`}`)
  pass += 1
  console.log(`  ✓ ${label}`)
}

const calls = []
const makeAgent = (sessionId) => ({
  abortBash: async () => { calls.push(`abort:${sessionId}`) },
  lastAssistantText: async () => `reply:${sessionId}`,
  getState: () => ({ sessionId })
})
const agentA = makeAgent('A')
const agentB = makeAgent('B')
const agents = new Map([['r1', agentA], ['r2', agentB]])
const statuses = [
  { id: 'r1', runId: 'r1', generation: 5, sessionId: 'A' },
  { id: 'r2', runId: 'r2', generation: 7, sessionId: 'B' }
]
const host = {
  ac: () => agentB,
  runners: () => ({
    statuses: () => statuses,
    agentOf: (id) => agents.get(id) ?? null
  })
}

console.log('▌中止 bash：只认渲染端给出的目标')
{
  calls.length = 0
  await abortBashFor(host, { runId: 'r1', sessionId: 'A', generation: 5 })
  ok(calls.join(',') === 'abort:A', '目标一致时只中止目标实例', calls)

  calls.length = 0
  await abortBashFor(host, { runId: 'r1', sessionId: 'A', generation: 4 })
  ok(calls.length === 0, 'runner 换代后过期目标不中止任何实例', calls)

  calls.length = 0
  await abortBashFor(host, { runId: 'r2', sessionId: 'A', generation: 7 })
  ok(calls.length === 0, '会话与运行实例不一致时不中止', calls)

  calls.length = 0
  await abortBashFor(host, { runId: 'r1', sessionId: 'B', generation: 5 })
  ok(calls.length === 0, '目标会话已被别的视图占用时不中止', calls)

  calls.length = 0
  await abortBashFor(host, { runId: 'gone', generation: 1 })
  ok(calls.length === 0, '目标实例已退出时不回退到活动实例', calls)
}

console.log('▌复制末条回复：只读目标实例')
{
  ok((await lastAssistantTextFor(host, { runId: 'r1', sessionId: 'A', generation: 5 })) === 'reply:A', '目标一致时读目标实例')
  ok((await lastAssistantTextFor(host, { runId: 'r1', sessionId: 'A', generation: 4 })) === null, 'runner 换代后过期目标返回空，不读活动实例')
  ok((await lastAssistantTextFor(host, { runId: 'gone', generation: 1 })) === null, '目标实例已退出时返回空')
  ok((await lastAssistantTextFor(host, { runId: 'r2', sessionId: 'A', generation: 7 })) === null, '会话归属不符时返回空')
  ok((await lastAssistantTextFor(host)) === 'reply:B', '未传目标（老调用）仍用活动实例')
}

console.log('▌渲染端拿不到 owner 的路径')
{
  ok((await lastAssistantTextFor(host, { runId: 'r1', sessionId: 'A', generation: 6 })) === null, '切换后旧 generation 不读新实例')
  calls.length = 0
  await abortBashFor(host, { runId: 'r1', sessionId: 'A', generation: 6 })
  ok(calls.length === 0, '切换后旧 generation 不中止新实例')
}

console.log(`会话命令目标核对：${pass} 项通过`)
