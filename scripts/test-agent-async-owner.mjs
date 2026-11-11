#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = await mkdtemp(join(tmpdir(), 'yan-async-owner-'))
process.env.YAN_DATA_DIR = join(root, 'data')
process.env.YAN_PI_DIR = join(root, 'pi')
process.env.YAN_ATTACHMENTS_DIR = join(root, 'attachments')

const outfile = join(process.cwd(), 'out', 'test', 'agent-async-owner.mjs')
await mkdir(dirname(outfile), { recursive: true })
await build({
  stdin: {
    contents: "export { AgentController } from './src/main/agent'; export { createRunsHost } from './src/main/runs-host'",
    resolveDir: process.cwd(),
    loader: 'ts'
  },
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'],
  plugins: [{
    name: 'async-owner-electron-boundary',
    setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'owner-electron' }))
      builder.onLoad({ filter: /.*/, namespace: 'owner-electron' }, () => ({
        loader: 'js',
        contents: `
          export class BrowserWindow {}
          export const session = { fromPartition() {} }
          export const app = { getLocale: () => 'zh-CN', getPath: () => process.env.YAN_DATA_DIR, getVersion: () => '0.0.0', isPackaged: false }
          export const nativeImage = { createFromBuffer: () => ({ isEmpty: () => true, resize: () => ({}) }) }
          export const safeStorage = { isEncryptionAvailable: () => false }
        `
      }))
    }
  }],
  logLevel: 'silent'
})
const { AgentController, createRunsHost } = await import(pathToFileURL(outfile).href)

let checks = 0
const check = (condition, message) => {
  assert.ok(condition, message)
  checks += 1
  console.log(`✓ ${message}`)
}
const deferred = () => {
  let release
  const promise = new Promise((resolve) => { release = resolve })
  return { promise, release }
}
const file = join(root, 's.jsonl')
const stateData = (extra = {}) => ({ sessionId: 's', sessionFile: file, cwd: process.cwd(), isStreaming: false, isCompacting: false, ...extra })

function controller({ commands, observeRun } = {}) {
  const pushed = []
  const ctl = new AgentController({ push: (event) => pushed.push(event), cwd: process.cwd(), ...(observeRun ? { observeRun } : {}) })
  ctl.state = { sessionId: 's', sessionFile: file, cwd: process.cwd(), isStreaming: false, isCompacting: false }
  ctl.capabilityOpts = { runnerGeneration: 1 }
  ctl.messages = [{ id: 'history:0', role: 'user', text: '旧内容', createdAt: 0 }]
  ctl.refreshTodos = async () => {}
  ctl.maybeGenerateTitle = async () => {}
  ctl.reclaimSavedQueue = async () => {}
  ctl.pushQuestionLog = () => {}
  ctl.pushApprovalLog = () => {}
  const rpc = {
    running: true,
    close: async () => {},
    command: async (type, payload) => commands?.[type] ? commands[type](payload) : { success: true, data: stateData() }
  }
  ctl.rpc = rpc
  return { ctl, pushed, rpc }
}
const channels = (pushed, ch) => pushed.filter((event) => event.ch === ch)

console.log('--- hydrate：get_state 在途时代次变化 ---')
{
  const gate = deferred()
  const { ctl, pushed } = controller({ commands: { get_state: async () => { await gate.promise; return { success: true, data: stateData({ sessionName: '新名字' }) } } } })
  ctl.readHistoryOf = async () => { throw new Error('不应读取历史') }
  const pending = ctl.hydrate()
  ctl.capabilityOpts.runnerGeneration = 2
  gate.release()
  const result = await pending
  check(result.ok === false && result.changed === true, '代次变化后 hydrate 以被取代结束')
  check(ctl.state.sessionName === undefined && channels(pushed, 'state').length === 0, '旧响应不写状态、不推 state')
  check(ctl.messages[0]?.text === '旧内容' && channels(pushed, 'sync').length + channels(pushed, 'sync-delta').length === 0, '旧响应不改消息、不推同步')
}

console.log('--- hydrate：get_state 在途时 rpc 被替换 ---')
{
  const gate = deferred()
  const { ctl, pushed } = controller({ commands: { get_state: async () => { await gate.promise; return { success: true, data: stateData({ sessionName: '旧 rpc' }) } } } })
  const pending = ctl.hydrate({ sessionId: 's', sessionFile: file })
  ctl.rpc = { running: true, command: async () => ({ success: true, data: stateData() }) }
  gate.release()
  const result = await pending
  check(result.ok === false && ctl.state.sessionName === undefined && channels(pushed, 'state').length === 0, 'rpc 已替换：旧响应被丢弃')
}

console.log('--- hydrate：get_messages 延迟返回后代次变化 ---')
{
  const gate = deferred()
  const { ctl, pushed } = controller({
    commands: {
      get_messages: async () => { await gate.promise; return { success: true, data: { messages: [{ role: 'user', content: '旧 rpc 的消息', timestamp: 1 }] } } }
    }
  })
  ctl.readHistoryOf = async () => null
  const pending = ctl.hydrate()
  await new Promise((resolve) => setImmediate(resolve))
  ctl.capabilityOpts.runnerGeneration = 2
  gate.release()
  const result = await pending
  check(result.ok === false && result.changed === true, '消息读取返回时代次已变：被取代')
  check(ctl.messages[0]?.text === '旧内容', '旧消息不写入当前运行实例')
  check(channels(pushed, 'sync').length + channels(pushed, 'sync-delta').length === 0 && channels(pushed, 'stats').length === 0, '不推同步也不推统计')
}

console.log('--- hydrate：读历史后会话已切走 ---')
{
  const gate = deferred()
  const { ctl, pushed } = controller()
  ctl.readHistoryOf = async () => {
    await gate.promise
    return { messages: [{ id: 'history:1', role: 'user', text: 'a 的历史', createdAt: 1 }], total: 1, truncated: 0, bytes: 1 }
  }
  const pending = ctl.hydrate()
  await new Promise((resolve) => setImmediate(resolve))
  ctl.state = { ...ctl.state, sessionId: 'other', sessionFile: join(root, 'other.jsonl') }
  gate.release()
  const result = await pending
  check(result.ok === false && ctl.messages[0]?.text === '旧内容', '没有 expected 时会话被切走同样不回填')
  check(channels(pushed, 'sync').length + channels(pushed, 'sync-delta').length === 0, '不推旧会话同步')
}

console.log('--- hydrate：统计在途时代次变化 ---')
{
  const gate = deferred()
  const { ctl, pushed } = controller({
    commands: {
      get_session_stats: async () => { await gate.promise; return { success: true, data: { tokens: { input: 1, output: 1, total: 2 }, cost: 0 } } }
    }
  })
  ctl.readHistoryOf = async () => ({ messages: [{ id: 'history:1', role: 'user', text: '新历史', createdAt: 1 }], total: 1, truncated: 0, bytes: 1 })
  const pending = ctl.hydrate()
  await new Promise((resolve) => setTimeout(resolve, 20))
  ctl.capabilityOpts.runnerGeneration = 2
  gate.release()
  await pending
  check(channels(pushed, 'stats').length === 0, '统计返回时代次已变：不推 stats')
}

console.log('--- hydrate：归属不变时照常提交 ---')
{
  const { ctl, pushed } = controller()
  ctl.readHistoryOf = async () => ({ messages: [{ id: 'history:1', role: 'user', text: '新历史', createdAt: 1 }], total: 1, truncated: 0, bytes: 1 })
  const result = await ctl.hydrate({ sessionId: 's', sessionFile: file })
  check(result.ok === true && ctl.messages[0]?.text === '新历史', '归属不变：一次性提交新历史')
  check(channels(pushed, 'sync').length + channels(pushed, 'sync-delta').length > 0, '归属不变：推送同步')
}

console.log('--- refreshState：返回时代次或 rpc 变化 ---')
{
  const gate = deferred()
  const { ctl, pushed } = controller({ commands: { get_state: async () => { await gate.promise; return { success: true, data: stateData({ sessionName: '旧代次' }) } } } })
  const pending = ctl.refreshState()
  ctl.capabilityOpts.runnerGeneration = 2
  gate.release()
  await pending
  check(ctl.state.sessionName === undefined && channels(pushed, 'state').length === 0, 'refreshState 代次变化后不写状态不推送')
}
{
  const gate = deferred()
  const { ctl, pushed } = controller({ commands: { get_state: async () => { await gate.promise; return { success: true, data: stateData({ sessionName: '旧 rpc' }) } } } })
  const pending = ctl.refreshState()
  ctl.rpc = { running: true, command: async () => ({ success: true, data: stateData() }) }
  gate.release()
  await pending
  check(ctl.state.sessionName === undefined && channels(pushed, 'state').length === 0, 'refreshState rpc 替换后不写状态不推送')
}

console.log('--- refreshStateWithThinkingLevels：多段等待后核对归属 ---')
{
  const gate = deferred()
  let calls = 0
  const { ctl, pushed } = controller({
    commands: {
      get_state: async () => { calls += 1; if (calls === 2) await gate.promise; return { success: true, data: stateData({ sessionName: `第 ${calls} 次` }) } },
      get_available_thinking_levels: async () => ({ success: true, data: { levels: ['off'] } })
    }
  })
  const pending = ctl.refreshStateWithThinkingLevels()
  await new Promise((resolve) => setTimeout(resolve, 20))
  ctl.capabilityOpts.runnerGeneration = 2
  gate.release()
  await pending
  check(ctl.state.sessionName === undefined && channels(pushed, 'state').length === 0, '第二次 get_state 返回时代次已变：不写不推')
}
{
  const { ctl, pushed } = controller({
    commands: {
      get_state: async () => ({ success: true, data: stateData({ sessionName: '正常' }) }),
      get_available_thinking_levels: async () => ({ success: true, data: { levels: ['off'] } })
    }
  })
  await ctl.refreshStateWithThinkingLevels()
  check(ctl.state.sessionName === '正常' && channels(pushed, 'state').length === 1, '归属不变：正常写状态')
}

console.log('--- stop：经运行观察器补发 host 终态 ---')
{
  const signals = []
  const { ctl } = controller({ observeRun: (ctx, signal) => signals.push({ ctx, signal }) })
  ctl.agentRunning = false
  await ctl.stop()
  const stopped = signals.filter((item) => item.signal.type === 'stopped')
  check(stopped.length === 1 && stopped[0].signal.by === 'host' && stopped[0].ctx.sessionId === 's', 'stop 在 rpc 置空前发一次 {stopped, host}')
}
{
  const runRoot = join(root, 'runs')
  const host = await createRunsHost({ root: runRoot, push: () => {}, newRunId: () => 'run-owner-1' })
  const { ctl } = controller({ observeRun: host.observerFor({ generation: 1 }) })
  ctl.agentRunning = false
  const observe = host.observerFor({ generation: 1 })
  observe({ sessionId: 's' }, { type: 'agent-start' })
  const started = Date.now()
  while (host.snapshot().runs.length === 0 && Date.now() - started < 5000) await new Promise((resolve) => setTimeout(resolve, 10))
  check(host.snapshot().runs.some((run) => run.phase.kind === 'running'), '前置：登记了一条运行中的 run')
  await ctl.stop()
  const runs = host.snapshot().runs
  check(runs.length === 1 && runs.every((run) => ['done', 'stopped', 'failed'].includes(run.phase.kind)), 'stop 后 RunRegistry 没有非终态条目')
  await host.dispose()
}

await rm(root, { recursive: true, force: true })
console.log(`\n异步归属与停止终态：${checks} 项通过`)
