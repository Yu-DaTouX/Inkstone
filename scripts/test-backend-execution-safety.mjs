import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'
import { build } from 'esbuild'
import { applyTestEnv } from './lib/test-env.mjs'

applyTestEnv()
await mkdir(join(process.cwd(), '.tmp'), { recursive: true })
const root = await mkdtemp(join(process.cwd(), '.tmp', 'backend-execution-safety-'))
process.env.YAN_DATA_DIR = join(root, 'data')
process.env.YAN_PI_DIR = join(root, 'pi')
process.env.YAN_ATTACHMENTS_DIR = join(root, 'attachments')
let restored = 0
let releaseRestore
const bundle = join(root, 'execution.mjs')
await build({
  stdin: {
    contents: `export { AgentController } from './src/main/agent'; export { RunnerRegistry } from './src/main/runners'; export { registerCheckpointIpc } from './src/main/ipc/checkpoint-ipc'; export { reserveWorkspaceMutation, workspaceMutationInProgress } from './src/main/workspace-mutation';`,
    resolveDir: process.cwd(), loader: 'ts'
  },
  outfile: bundle, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent',
  external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'],
  plugins: [{
    name: 'execution-fixtures',
    setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
      builder.onResolve({ filter: /^\.\.\/checkpoints$/ }, () => ({ path: 'checkpoints', namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({
        contents: path === 'electron'
          ? `export const app = { getLocale: () => 'zh-CN', getPath: () => process.env.YAN_DATA_DIR, getVersion: () => '0', isPackaged: false }; export const nativeImage = {}; export const safeStorage = { isEncryptionAvailable: () => false }; export class BrowserWindow {}; export const session = {};`
          : `export const assessCheckpointFit = async () => null; export const listCheckpoints = async () => []; export const previewCheckpoint = async () => null; export const restoreCheckpoint = (...args) => globalThis.__executionRestore(...args);`,
        loader: 'js'
      }))
    }
  }]
})
const { AgentController, RunnerRegistry, registerCheckpointIpc, reserveWorkspaceMutation, workspaceMutationInProgress } = await import(pathToFileURL(bundle).href)
globalThis.__executionRestore = async () => {
  restored += 1
  if (releaseRestore) await releaseRestore
  return { ok: true, restored: 1 }
}
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
const flush = () => new Promise((done) => setImmediate(done))
const index = await readFile('src/main/index.ts', 'utf8')
const sendStart = index.indexOf("  handle('yan:send',")
const sendEnd = index.indexOf("  handle('yan:steer',", sendStart)
assert.ok(sendStart >= 0 && sendEnd > sendStart)
const sendCode = ts.transpileModule(index.slice(sendStart, sendEnd), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText

for (const changed of [false, true]) {
  const captured = deferred()
  const events = []
  const cwd = join(root, `send-${changed}`)
  const target = { runId: 'r1', generation: 7, sessionId: 's1' }
  let current = true
  let claimed = false
  let released = false
  let handler
  const agent = {
    running: true,
    workingDirectory: cwd,
    getState: () => ({ ...target, isAgentRunning: false }),
    hasRunningBash: () => false,
    send: async (_text, _images, _mode, _scope, generation) => {
      assert.equal(generation, 7)
      assert.equal(claimed, true)
      assert.equal(workspaceMutationInProgress(cwd), false)
      events.push('send')
      return { ok: true }
    }
  }
  const registry = {
    activeRunnerId: 'r1', agentOf: () => agent, runtimeOf: () => target,
    guardExecute: () => ({ ok: true }),
    admitExecute: () => { claimed = true; return { ok: true, token: 1 } },
    releaseExecute: () => { released = true }
  }
  vm.runInNewContext(sendCode, {
    handle: (_channel, fn) => { handler = fn }, runners: registry,
    normalizeExpectedRuntime: (input) => input, resolveExpectedTarget: () => 'r1', targetMatchesExpected: () => current,
    pinSendTarget: () => ({ ...target, agent }), pinnedTargetMatches: () => current,
    getSettings: async () => ({ checkpointsEnabled: true }), reserveWorkspaceMutation,
    captureCheckpoint: async () => { events.push('capture-start'); await captured.promise; events.push('capture-finished') }
  })
  const pending = handler('fixture', undefined, undefined, target)
  await flush()
  assert.deepEqual(events, ['capture-start'])
  assert.equal(workspaceMutationInProgress(cwd), true)
  assert.equal(claimed, true)
  if (changed) current = false
  captured.resolve()
  const result = await pending
  assert.equal(result.ok, !changed)
  assert.deepEqual(events, changed ? ['capture-start', 'capture-finished'] : ['capture-start', 'capture-finished', 'send'])
  assert.equal(released, changed)
  assert.equal(workspaceMutationInProgress(cwd), false)
}
console.log('✓ 发送等待快照，持有执行入场，目标变化时取消并释放')

const pushStart = index.indexOf('        push: (m) => {', index.indexOf('    createAgent:'))
const pushEnd = index.indexOf('        observeRun:', pushStart)
assert.ok(pushStart >= 0 && pushEnd > pushStart)
const makePush = ts.transpileModule(`(function(id, agent) { return ({ ${index.slice(pushStart, pushEnd)} }).push })`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const pushed = []
let nextSession = 0
let registry
const context = { runners: null, pushFrom: (id, msg) => pushed.push({ id, msg, runtime: registry.runtimeOf(id) }) }
const bindPush = vm.runInNewContext(makePush, context)
const makeAgent = (id, cwd) => {
  const agent = {
    state: { sessionId: `fixture-${++nextSession}`, cwd },
    get workingDirectory() { return cwd },
    getState() { return this.state },
    getPendingUiCount: () => 0, hasRunningBash() { return this.bashRunning === true },
    getConn: () => ({ state: 'ready' }), setRunnerGeneration: () => {},
    queueSnapshot: () => ({ steering: [], followUp: [] }),
    start: async () => ({ ok: true }), newSession: async () => ({ ok: true }),
    stop: async () => agent.emit({ ch: 'proc', payload: { state: 'exited' } })
  }
  agent.emit = bindPush(id, agent)
  return agent
}
registry = new RunnerRegistry({ limit: 1, createAgent: makeAgent })
context.runners = registry
const first = await registry.select({ cwd: join(root, 'first') })
const oldAgent = registry.agentOf(first.id)
oldAgent.emit({ ch: 'proc', payload: { state: 'ready' } })
assert.equal(pushed.length, 1)
const second = await registry.select({ cwd: join(root, 'second') })
assert.equal(second.via, 'reuse')
assert.equal(pushed.length, 1)
registry.agentOf(second.id).emit({ ch: 'proc', payload: { state: 'ready' } })
assert.equal(pushed.at(-1).runtime.generation, second.generation)
console.log('✓ 被替换实例的退出事件不会串入新会话')

const controller = (cwd = join(root, 'controller')) => {
  const ctl = new AgentController({ push: () => {}, cwd })
  ctl.state = { sessionId: 'active', cwd, isAgentRunning: true, isStreaming: true }
  ctl.agentRunning = true
  return ctl
}
for (const success of [true, false]) {
  const ctl = controller()
  const aborted = deferred()
  let released = false
  ctl.capabilityOpts = { runnerGeneration: 4, execution: { claim: () => ({ ok: true, token: 1 }), confirm: () => true, release: () => { released = true } } }
  ctl.executionAdmissionToken = 1
  ctl.refreshState = async () => ctl.state
  ctl.rpc = { command: async (command) => command === 'abort' ? aborted.promise : ({ success: true, data: {} }) }
  const pending = ctl.abort(4)
  await flush()
  assert.equal(released, false)
  assert.equal(ctl.state.isAgentRunning, true)
  assert.equal((await ctl.send('new task')).ok, false)
  ctl.releaseExecutionAdmission()
  assert.equal(released, false)
  aborted.resolve({ success, error: success ? undefined : 'fixture abort failure' })
  const result = await pending
  assert.equal(ctl.state.isAgentRunning, !success)
  if (success) {
    ctl.releaseExecutionAdmission()
    assert.equal(released, true)
  } else {
    assert.match(result.error, /fixture abort failure/)
    assert.equal(released, false)
    assert.equal(ctl.executionAdmissionToken, 1)
  }
}
console.log('✓ 停止确认前保持忙碌和执行保护，失败不假装已停止')

{
  const ctl = controller()
  ctl.capabilityOpts = { runnerGeneration: 2 }
  assert.equal((await ctl.send('old task', undefined, undefined, undefined, 1)).ok, false)
  const state = deferred()
  let applied = false
  ctl.rpc = { command: () => state.promise }
  ctl.setStateFrom = () => { applied = true }
  const pending = ctl.refreshState()
  ctl.state = { ...ctl.state, sessionId: 'replacement' }
  state.resolve({ success: true, data: { sessionId: 'active' } })
  await pending
  assert.equal(applied, false)
  assert.equal(ctl.state.sessionId, 'replacement')
}
console.log('✓ 旧 generation 发送及迟到的状态读取被拒绝')

{
  const cwd = join(root, 'restore')
  const reg = new RunnerRegistry({ limit: 2, createAgent: makeAgent })
  const a = await reg.select({ cwd, hidden: true })
  const b = await reg.select({ cwd, hidden: true, activate: false })
  const active = reg.agentOf(a.id)
  const other = reg.agentOf(b.id)
  const handlers = new Map()
  registerCheckpointIpc({ handle: (channel, fn) => handlers.set(channel, fn) }, { ac: () => active, runners: () => reg })
  const restore = handlers.get('yan:checkpoints:restore')
  other.bashRunning = true
  assert.equal((await restore('point')).ok, false)
  other.bashRunning = false
  other.state.isCompacting = true
  assert.equal((await restore('point')).ok, false)
  other.state.isCompacting = false
  const claim = reg.admitExecute(b.id)
  assert.equal(claim.ok, true)
  assert.equal(reg.hasExecutionAdmission(cwd), true)
  assert.equal((await restore('point')).ok, false)
  reg.releaseExecute(b.id, claim.token)
  assert.equal(restored, 0)
  const done = deferred()
  releaseRestore = done.promise
  const pending = restore('point')
  await flush()
  assert.equal(workspaceMutationInProgress(cwd), true)
  const ctl = controller(cwd)
  ctl.rpc = { command: async () => { throw new Error('should not execute') } }
  assert.equal((await ctl.runBash('fixture')).ok, false)
  assert.equal((await ctl.send('fixture')).ok, false)
  assert.equal((await ctl.compact()).ok, false)
  done.resolve()
  assert.equal((await pending).ok, true)
  assert.equal(workspaceMutationInProgress(cwd), false)
  releaseRestore = null
}
console.log('✓ 回退与同目录 Bash、压缩、待提交执行双向互斥')

{
  const cwd = join(root, 'capture')
  await mkdir(cwd)
  const gitStarted = deferred()
  const gitFinished = deferred()
  let running = false
  globalThis.__checkpointGit = async (_cwd, args) => {
    if (args.includes('ls-files')) {
      running = true
      gitStarted.resolve()
      await gitFinished.promise
      running = false
      return { ok: false, stdout: '', stderr: '' }
    }
    return { ok: true, stdout: '', stderr: '' }
  }
  const output = join(root, 'checkpoint-timeout.mjs')
  await build({
    entryPoints: ['src/main/checkpoints.ts'], outfile: output, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent',
    plugins: [{ name: 'delayed-git', setup(builder) {
      builder.onResolve({ filter: /^\.\/git-service$/ }, () => ({ path: 'git', namespace: 'delayed' }))
      builder.onLoad({ filter: /.*/, namespace: 'delayed' }, () => ({ contents: `export const gitRun = (...args) => globalThis.__checkpointGit(...args);`, loader: 'js' }))
    } }]
  })
  const { captureCheckpoint } = await import(pathToFileURL(output).href)
  let settled = false
  const pending = captureCheckpoint(cwd, 'session', 'fixture', 25).then((value) => { settled = true; return value })
  await gitStarted.promise
  await new Promise((done) => setTimeout(done, 40))
  assert.equal(settled, false)
  assert.equal(running, true)
  gitFinished.resolve()
  assert.equal(await pending, null)
  assert.equal(running, false)
  delete globalThis.__checkpointGit
}
console.log('✓ 快照预算超时后，仍等后台读取结束才允许发送')
delete globalThis.__executionRestore
console.log('backend execution safety ok')
