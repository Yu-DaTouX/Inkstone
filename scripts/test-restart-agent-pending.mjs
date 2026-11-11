#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'

let checks = 0
const check = (condition, message) => { assert.ok(condition, message); checks += 1; console.log(`✓ ${message}`) }

const compiled = await build({ entryPoints: ['src/main/runners.ts'], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' })
const { RunnerRegistry } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)

const controls = new Map()
const agents = []
let subagents = new Set()
const refreshed = []
const failed = []
const makeAgent = (id) => {
  if (!controls.has(id)) controls.set(id, { sessionId: `session-${id}`, file: undefined, running: false, terminal: false, queue: { steering: [], followUp: [] } })
  const ctl = controls.get(id)
  const agent = {
    id,
    calls: [],
    getState: () => ({ sessionId: ctl.sessionId, sessionFile: ctl.file, isAgentRunning: ctl.running, isStreaming: false, isCompacting: false, pendingMessageCount: 0 }),
    getConn: () => ({ state: 'ready' }),
    getPendingUiCount: () => 0,
    hasRunningBash: () => false,
    hasPendingTerminalWork: () => ctl.terminal,
    queueSnapshot: () => ctl.queue,
    start: async () => ({ ok: true }),
    newSession: async () => { agent.calls.push('newSession'); return { ok: true } },
    switchSession: async (file) => { agent.calls.push(`switch:${file}`); ctl.file = file; return { ok: true } },
    restoreQueueSnapshot: async (queue) => { agent.calls.push(`queue:${queue.steering.length}`); return { ok: true } },
    stop: async () => { agent.calls.push('stop') },
    setRunnerGeneration: () => {}
  }
  agents.push(agent)
  return agent
}
const registry = new RunnerRegistry({
  createAgent: (id) => makeAgent(id),
  hasRunningSubagents: (sessionId) => subagents.has(sessionId),
  onRefreshed: (id) => refreshed.push(id),
  onRefreshFailed: (id, error) => failed.push({ id, error })
})
const a = await registry.select({ cwd: 'C:/proj/a', sessionFile: 'C:/s/a.jsonl' })
const b = await registry.select({ cwd: 'C:/proj/b', sessionFile: 'C:/s/b.jsonl', activate: false })
const c = await registry.select({ cwd: 'C:/proj/c', activate: false })
check(a.ok && b.ok && c.ok && registry.size === 3, '前置：三个运行实例')
const agentOf = (id) => registry.agentOf(id)
const [a0, b0, c0] = [agentOf(a.id), agentOf(b.id), agentOf(c.id)]
const spawned = () => agents.length

check(registry.hasBusy() === false, '后台终端待办时 hasBusy 看不到（原判据会误判为空闲）')
controls.get(a.id).terminal = true
controls.get(b.id).queue = { steering: [], followUp: [] }
check(registry.hasBusy() === false && registry.hasPendingWorkExcept() === true, '只有后台终端：待办判据为真')

const before = spawned()
const outcome = await registry.refreshInstances()
check(outcome.deferred.length === 1 && outcome.deferred[0] === a.id, '有待办的实例被标记延后')
check(agentOf(a.id) === a0 && !a0.calls.includes('stop'), '后台终端待办的实例没有被停止或替换')
check(agentOf(b.id) !== b0 && b0.calls.includes('stop') && agentOf(b.id).calls.includes('switch:C:/s/b.jsonl'), '无待办的实例立即重启并接回原会话')
check(agentOf(c.id) !== c0 && agentOf(c.id).calls.includes('newSession'), '无待办且未保存的实例原地重建')
check(outcome.restarted.length === 2 && outcome.failed.length === 0 && spawned() === before + 2, '结果：重启 2 个，没有失败')
check(registry.size === 3 && registry.activeRunnerId === a.id, '实例身份与当前会话保持不变')
check(registry.pendingRefreshIds().length === 1 && registry.pendingRefreshIds()[0] === a.id, '待刷新实例已登记')

await registry.refreshStale()
check(agentOf(a.id) === a0 && refreshed.length === 0, '待办未清空时刷新仍然等待')
controls.get(a.id).queue = { steering: ['排队消息'], followUp: [] }
controls.get(a.id).terminal = false
registry.noteStateChange(a.id)
await new Promise((resolve) => setImmediate(resolve))
check(agentOf(a.id) === a0, '还有排队消息：仍不重启')
controls.get(a.id).queue = { steering: [], followUp: [] }
registry.noteStateChange(a.id)
const started = Date.now()
while (agentOf(a.id) === a0 && Date.now() - started < 3000) await new Promise((resolve) => setTimeout(resolve, 10))
check(agentOf(a.id) !== a0 && a0.calls.includes('stop') && agentOf(a.id).calls.includes('switch:C:/s/a.jsonl'), '待办清空后该实例被重启并接回会话')
check(refreshed.length === 1 && refreshed[0] === a.id && registry.pendingRefreshIds().length === 0 && failed.length === 0, '登记已清除，并通知刷新完成')
check(registry.activeRunnerId === a.id && registry.size === 3, '刷新后会话与实例身份不变')

subagents = new Set([controls.get(b.id).sessionId])
const second = await registry.refreshInstances()
check(second.deferred.includes(b.id) && second.restarted.length === 2, '只有运行中子代理待办：该实例延后，其余照常刷新')
subagents = new Set()
await registry.refreshStale()
check(registry.pendingRefreshIds().length === 0 && refreshed.includes(b.id), '子代理结束后补刷新')

const source = await readFile('src/main/index.ts', 'utf8')
const start = source.indexOf('async function restartAgent(')
const end = source.indexOf('function registerIpc()', start)
const body = source.slice(start, end)
check(start > 0 && end > start, '定位 restartAgent')
check(body.includes('refreshInstances()') && !body.includes('hasBusy()') && !body.includes('setTimeout'), 'restartAgent 按实例刷新，不再整体等待')
check(/registry\.size === 0\)\s*\{\s*await registry\.stopAll\(\)/.test(body) && body.split('stopAll()').length === 2, '只有没有运行实例时才走整体重建')
check(body.includes('配置已保存') && body.includes('Settings saved'), '延后时给出中英文提示')
console.log(`restart-agent-pending: ${checks} 项通过`)
