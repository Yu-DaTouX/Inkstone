import assert from 'node:assert/strict'
import { build } from 'esbuild'

let checks = 0
const ok = (condition, label, detail) => {
  assert.ok(condition, `${label}${detail === undefined ? '' : ` ← ${JSON.stringify(detail)}`}`)
  checks++
}

const compiled = await build({ entryPoints: ['src/main/runners.ts'], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' })
const { RunnerRegistry } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)

const states = new Map()
let subagents = new Set()
const makeAgent = (id) => {
  const state = { sessionId: `session-${id}`, running: false, bash: false, terminal: false, pendingUi: 0, queue: { steering: [], followUp: [] } }
  states.set(id, state)
  return {
    getState: () => ({ sessionId: state.sessionId, isAgentRunning: state.running, isStreaming: false, isCompacting: false, pendingMessageCount: 0 }),
    getConn: () => ({ state: 'ready' }),
    getPendingUiCount: () => state.pendingUi,
    hasRunningBash: () => state.bash,
    hasPendingTerminalWork: () => state.terminal,
    queueSnapshot: () => state.queue,
    start: async () => ({ ok: true }),
    newSession: async () => ({ ok: true }),
    switchSession: async () => ({ ok: true }),
    stop: async () => {},
    setRunnerGeneration: () => {}
  }
}
const registry = new RunnerRegistry({ createAgent: (id) => makeAgent(id), hasRunningSubagents: (sessionId) => subagents.has(sessionId) })
const one = await registry.select({ cwd: 'C:/proj/one' })
const two = await registry.select({ cwd: 'C:/proj/two' })
ok(one.ok && two.ok, '两个运行实例已建立', [one.error, two.error])
const s1 = states.get(one.id)
const s2 = states.get(two.id)

ok(registry.sessionHasPendingWork(s1.sessionId) === false, '空闲会话没有待办')
ok(registry.sessionHasPendingWork('unknown') === false, '没有运行实例的会话没有待办')
s1.running = true
ok(registry.sessionHasPendingWork(s1.sessionId) === true, '正在运行算待办')
ok(registry.sessionHasPendingWork(s2.sessionId) === false, '别的会话不受影响')
s1.running = false
s1.bash = true
ok(registry.sessionHasPendingWork(s1.sessionId) === true, '用户 bash 在跑算待办')
s1.bash = false
s1.queue = { steering: ['x'], followUp: [] }
ok(registry.sessionHasPendingWork(s1.sessionId) === true, '排队消息算待办')
s1.queue = { steering: [], followUp: [] }
s1.terminal = true
ok(registry.sessionHasPendingWork(s1.sessionId) === true, '后台终端任务算待办')
s1.terminal = false
subagents = new Set([s1.sessionId])
ok(registry.sessionHasPendingWork(s1.sessionId) === true, '运行中的子代理算待办')
subagents = new Set()
s1.pendingUi = 1
ok(registry.sessionHasPendingWork(s1.sessionId) === true, '待答复的审批算待办')
s1.pendingUi = 0
ok(registry.sessionHasPendingWork(s1.sessionId) === false, '状态清空后恢复为无待办')

s2.running = true
ok(registry.hasPendingWorkExcept(two.id) === false && registry.hasPendingWorkExcept(one.id) === true, '与 hasPendingWorkExcept 使用同一判据，只是过滤维度不同')
await registry.stopAll()
console.log(`runners session pending: ${checks} checks passed`)
