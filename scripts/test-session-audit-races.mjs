import assert from 'node:assert/strict'
import { readFile, mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { build } from 'esbuild'

const watchdog = setTimeout(() => { console.error('Session audit regression timed out'); process.exit(1) }, 30_000)
const output = resolve('.tmp/full-audit-fixes/session')
await mkdir(output, { recursive: true })
let passed = 0
async function check(name, run) {
  await run()
  passed++
  console.log(`PASS ${name}`)
}
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
const parse = async path => ts.createSourceFile(path, await readFile(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const evaluate = (source, bindings) => {
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  return new Function(...Object.keys(bindings), js)(...Object.values(bindings))
}
const ipcSource = await parse('src/main/ipc/session-ipc.ts')
let deleteCallback
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(ipcSource) === 'handle' && node.arguments[0]?.text === 'yan:deleteSession') deleteCallback = node.arguments[1].getText(ipcSource)
  ts.forEachChild(node, visit)
}
visit(ipcSource)
assert.ok(deleteCallback)
function deletionFixture({ current, failAt, restoreFailures = [] } = {}) {
  const files = ['a', 'b', 'c'].map(name => resolve(output, `${name}.jsonl`))
  const calls = { stopped: [], deleted: [], restored: [], forgotten: 0, terminals: [] }
  const trashed = new Set()
  const host = {
    ac: () => ({ getState: () => ({ sessionFile: current?.(files) }) }),
    runners: () => ({ stopBySessionFile: async path => { calls.stopped.push(path) } }),
    pushRunners() {},
    sessionChains: {
      load: async () => {},
      chainOf: () => ({ segments: files.map(sessionFile => ({ sessionFile })) }),
      forget: async () => { calls.forgotten++ }
    }
  }
  const run = evaluate(`return (${deleteCallback})`, {
    host, resolve,
    planHistoryRead: chain => chain.segments.map(segment => segment.sessionFile),
    sessionsToDelete: async path => [{ path }],
    deleteSession: async path => {
      calls.deleted.push(path)
      if (path === files[failAt]) throw new Error('injected delete failure')
      const token = `token-${files.indexOf(path)}`
      trashed.add(token)
      return token
    },
    restoreSession: async token => {
      calls.restored.push(token)
      if (restoreFailures.includes(token)) throw new Error('injected restore failure')
      assert.ok(trashed.delete(token))
    },
    closeTerminalsForOwner: path => calls.terminals.push(path)
  })
  return { run: () => run(files[0]), calls, trashed }
}
await check('current chain segment rejected before stopping or deleting', async () => {
  const f = deletionFixture({ current: files => files[2] })
  assert.equal((await f.run()).ok, false)
  assert.deepEqual(f.calls.stopped, [])
  assert.deepEqual(f.calls.deleted, [])
  assert.deepEqual(f.calls.terminals, [])
})
await check('chain failure restores tokens in reverse order and keeps chain metadata', async () => {
  const f = deletionFixture({ failAt: 2 })
  const result = await f.run()
  assert.equal(result.ok, false)
  assert.equal(result.undoToken, undefined)
  assert.deepEqual(f.calls.restored, ['token-1', 'token-0'])
  assert.equal(f.trashed.size, 0)
  assert.equal(f.calls.forgotten, 0)
  assert.deepEqual(f.calls.terminals, [])
})
await check('failed rollback preserves only outstanding recovery tokens', async () => {
  const f = deletionFixture({ failAt: 2, restoreFailures: ['token-1'] })
  const result = await f.run()
  assert.equal(result.ok, false)
  assert.equal(result.undoToken, 'token-1')
  assert.deepEqual([...f.trashed], ['token-1'])
  assert.deepEqual(f.calls.restored, ['token-1', 'token-0'])
})
await check('successful chain deletion retains all undo tokens', async () => {
  const f = deletionFixture()
  assert.deepEqual(await f.run(), { ok: true, undoToken: 'token-0|token-1|token-2' })
  assert.equal(f.calls.forgotten, 1)
})

const runnerFile = join(output, 'runners.mjs')
await build({ entryPoints: ['src/main/runners.ts'], outfile: runnerFile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
const { RunnerRegistry } = await import(pathToFileURL(runnerFile).href)
for (const stop of ['stopOne', 'stopAll', 'none']) {
  for (const stage of ['start', 'switchSession', 'prepare']) {
    await check(`replacement ${stage}, stop=${stop}, registry ownership verified`, async () => {
      const entered = deferred()
      const release = deferred()
      const agents = []
      const pause = async currentStage => {
        if (agents.length === 2 && currentStage === stage) {
          entered.resolve()
          await release.promise
        }
        return { ok: true }
      }
      const registry = new RunnerRegistry({
        limit: 1,
        prepareNewSession: () => pause('prepare'),
        createAgent: () => {
          const agent = {
            stopped: 0,
            state: { sessionId: `s${agents.length}`, isAgentRunning: false },
            getState() { return this.state },
            getPendingUiCount: () => 0,
            hasRunningBash: () => false,
            getConn: () => ({ state: 'ready' }),
            setRunnerGeneration() {},
            start: () => pause('start'),
            async stop() { this.stopped++ },
            async switchSession(sessionFile) { this.state.sessionFile = sessionFile; return pause('switchSession') },
            newSession: () => pause('newSession')
          }
          agents.push(agent)
          return agent
        }
      })
      const initial = await registry.select({ cwd: 'C:/audit-a', sessionFile: 'initial' })
      const selecting = registry.select({ cwd: 'C:/audit-b', ...(stage === 'prepare' ? {} : { sessionFile: 'next' }) })
      await entered.promise
      if (stop === 'stopAll') await registry.stopAll()
      else if (stop === 'stopOne') await registry.stopOne(initial.id)
      release.resolve()
      assert.equal((await selecting).ok, stop === 'none')
      assert.equal(registry.size, stop === 'none' ? 1 : 0)
      assert.equal(registry.activeId, stop === 'none' ? initial.id : null)
      assert.equal(agents[1].stopped, stop === 'none' ? 0 : 1)
      assert.equal(agents[0].stopped, 1)
      await registry.stopAll()
    })
  }
}

const agentSource = await parse('src/main/agent.ts')
const agentClass = agentSource.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'AgentController')
assert.ok(agentClass)
const names = ['sessionReadCurrent', 'sessionEntriesLite', 'refreshTodos', 'taskPlanEntries']
const methods = names.map(name => {
  const method = agentClass.members.find(member => member.name?.getText(agentSource) === name)
  assert.ok(method, name)
  return method.getText(agentSource)
}).join('\n')
const TodoReader = evaluate(`return class TodoReader { ${methods} }`, {
  readTaskPlanLog: sessionId => globalThis.auditTaskLog(sessionId),
  taskPlanLogEntry: entry => entry,
  isSafeSessionId: value => typeof value === 'string',
  todoSnapshotsFromEntries: entries => entries.map(entry => ({ todos: [entry] }))
})
function todoFixture() {
  const reader = new TodoReader()
  const pushed = []
  reader.state = { sessionId: 'A', sessionFile: 'A.jsonl' }
  reader.rpc = { command: async () => ({ success: true, data: { entries: [{ source: 'rpc-A' }] } }) }
  reader.capabilityOpts = { runnerGeneration: 1 }
  reader.entriesLite = { entries: async () => [{ source: 'A' }] }
  reader.push = message => pushed.push(message)
  globalThis.auditTaskLog = async sessionId => [{ source: `host-${sessionId}` }]
  return { reader, pushed }
}
for (const stage of ['file', 'rpc', 'host']) {
  for (const change of ['session', 'file', 'generation', 'rpc', 'stop']) {
    await check(`todos ${stage} await rejects stale ${change}`, async () => {
      const { reader, pushed } = todoFixture()
      const entered = deferred()
      const release = deferred()
      const wait = async result => { entered.resolve(); await release.promise; return result }
      if (stage === 'file') reader.entriesLite.entries = () => wait(null)
      if (stage === 'rpc') {
        reader.entriesLite.entries = async () => null
        reader.rpc.command = () => wait({ success: true, data: { entries: [{ source: 'A' }] } })
      }
      const hostSessions = []
      globalThis.auditTaskLog = sessionId => {
        hostSessions.push(sessionId)
        return stage === 'host' ? wait([{ source: `host-${sessionId}` }]) : Promise.resolve([])
      }
      const reading = reader.refreshTodos()
      await entered.promise
      if (change === 'session') reader.state = { sessionId: 'B', sessionFile: 'B.jsonl' }
      if (change === 'file') reader.state.sessionFile = 'B.jsonl'
      if (change === 'generation') reader.capabilityOpts.runnerGeneration++
      if (change === 'rpc') reader.rpc = { command: async () => { throw new Error('must not use new RPC') } }
      if (change === 'stop') reader.stopping = true
      release.resolve()
      assert.deepEqual(await reading, [])
      assert.deepEqual(pushed, [])
      assert.deepEqual(hostSessions, stage === 'host' ? ['A'] : [])
    })
  }
}
await check('unchanged todos publish matching session entries and history', async () => {
  const { reader, pushed } = todoFixture()
  assert.deepEqual(await reader.refreshTodos(), [{ source: 'host-A' }])
  assert.deepEqual(pushed.map(message => message.ch), ['todos', 'todo-history'])
  assert.equal(pushed[1].payload[0].todos[0].source, 'A')
})
delete globalThis.auditTaskLog
console.log(`${passed} session audit regression checks passed`)
clearTimeout(watchdog)
