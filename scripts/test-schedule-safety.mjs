import assert from 'node:assert/strict'
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'
import { build } from 'esbuild'

const work = await mkdtemp(join(tmpdir(), 'inkstone-schedule-safety-'))
let checks = 0
const verify = (value, label) => { assert.ok(value, label); checks++ }
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const bundle = async (file, name) => {
  const output = join(work, name + '.mjs')
  await build({ entryPoints: [file], outfile: output, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  return import(pathToFileURL(output).href)
}
const input = { name: 'fixture', prompt: 'fixture only', trigger: { kind: 'interval', minutes: 5 } }
const services = []
try {
  const { ScheduleService } = await bundle('src/main/schedule-service.ts', 'schedule')
  const make = (file, options = {}) => { const service = new ScheduleService({ file, now: () => 100000, run: async () => ({ sessionId: 'ran' }), ...options }); services.push(service); return service }
  const corruptFile = join(work, 'corrupt.json')
  const corrupt = '{"v":1,"tasks":[{"id":"recoverable"}'
  await writeFile(corruptFile, corrupt)
  const broken = make(corruptFile)
  await assert.rejects(broken.start()); checks++
  verify(await readFile(corruptFile, 'utf8') === corrupt, 'malformed original preserved')
  await assert.rejects(broken.create(input, 'user')); checks++
  verify(await readFile(corruptFile, 'utf8') === corrupt, 'writes fail closed until file repaired')
  const wrongSchemaFile = join(work, 'wrong-schema.json')
  const wrongSchema = JSON.stringify({ v: 1, tasks: [{ id: 'bad', prompt: 'partial' }] })
  await writeFile(wrongSchemaFile, wrongSchema)
  await assert.rejects(make(wrongSchemaFile).start()); checks++
  verify(await readFile(wrongSchemaFile, 'utf8') === wrongSchema, 'invalid entry not silently discarded')

  const readErrorPath = join(work, 'read-is-directory')
  await mkdir(readErrorPath)
  await assert.rejects(make(readErrorPath).start()); checks++
  await assert.rejects(readFile(readErrorPath, 'utf8')); checks++
  const file = join(work, 'valid.json')
  let notifications = 0
  const service = make(file, { onChanged: () => { notifications++ } })
  await service.start()
  const created = await service.create(input, 'user')
  verify(created.ok, 'user task created')
  verify(created.task.enabled, 'user task enabled after save')
  const id = created.task.id
  const awaitingApproval = await service.create({ ...input, name: 'pending fixture' }, 'model')
  const originalTasks = service.list()
  const saved = await readFile(file, 'utf8')
  const beforeNotify = notifications
  await rm(file)
  await mkdir(file)
  await assert.rejects(service.create({ ...input, name: 'must not exist' }, 'user')); checks++
  verify(JSON.stringify(service.list()) === JSON.stringify(originalTasks), 'failed create not published')
  await assert.rejects(service.update(id, { prompt: 'must not replace' })); checks++
  verify(service.list()[0].prompt === input.prompt, 'failed update not published')
  await assert.rejects(service.setEnabled(id, false)); checks++
  verify(service.list()[0].enabled, 'failed pause not published')
  await assert.rejects(service.setEnabled(awaitingApproval.task.id, true)); checks++
  const stillPending = service.list().find(task => task.id === awaitingApproval.task.id)
  verify(!stillPending.enabled && stillPending.pendingApproval, 'failed enable leaves approval and disabled state intact')
  await assert.rejects(service.remove(id)); checks++
  verify(service.list().length === 2, 'failed remove not published')
  verify(notifications === beforeNotify, 'no success notification on failed writes')
  await rm(file, { recursive: true })
  await writeFile(file, saved)
  const concurrent = await Promise.all([service.create({ ...input, name: 'one' }, 'model'), service.create({ ...input, name: 'two' }, 'model')])
  verify(concurrent.every(x => x.ok), 'queue recovers after failed writes')
  verify(service.list().length === 4 && JSON.parse(await readFile(file, 'utf8')).tasks.length === 4, 'concurrent changes do not lose tasks')
  verify(concurrent.every(x => !x.task.enabled && x.task.pendingApproval), 'model-created tasks still need approval')
  const copy = service.list()
  copy[0].trigger.minutes = 999
  verify(service.list()[0].trigger.minutes === 5, 'list nested objects cannot mutate internal state')

  const running = defer()
  const fire = make(join(work, 'fire.json'), { run: () => running.promise })
  const runTask = await fire.create(input, 'user')
  const firing = fire.runNow(runTask.task.id)
  await new Promise(resolve => setImmediate(resolve))
  await fire.setEnabled(runTask.task.id, false)
  running.resolve({ sessionId: 'finished' })
  await firing
  verify(fire.list()[0].enabled === false && fire.list()[0].lastSessionId === 'finished', 'run completion keeps concurrent pause')
  const removedRun = defer()
  const removed = make(join(work, 'removed.json'), { run: () => removedRun.promise })
  const gone = await removed.create(input, 'user')
  const completing = removed.runNow(gone.task.id)
  await new Promise(resolve => setImmediate(resolve))
  await removed.remove(gone.task.id)
  removedRun.resolve({ sessionId: 'finished' })
  await completing
  verify(removed.list().length === 0, 'late completion does not resurrect removed task')

  const { RunnerRegistry } = await bundle('src/main/runners.ts', 'runners')
  const { sameRuntimeEnvelope } = await bundle('src/core/run-state.ts', 'identity')
  const source = await readFile('src/main/index.ts', 'utf8')
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let callback
  const functions = []
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'scheduleService') callback = node.initializer.arguments[0].properties.find(p => p.name?.getText(ast) === 'run').initializer.getText(ast)
    if (ts.isFunctionDeclaration(node) && ['pinSendTarget', 'pinnedTargetMatches'].includes(node.name?.text)) functions.push(node.getText(ast))
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.ok(callback && functions.length === 2)
  const dispatchCode = ts.transpileModule(functions.join('\n') + '\nglobalThis.dispatch = ' + callback, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const makeDispatch = (hooks = {}) => {
    const sent = []
    const registry = new RunnerRegistry({ createAgent: (id, cwd) => ({
      state: { sessionId: 'initial-' + id, cwd, isAgentRunning: false, isStreaming: false, isCompacting: false },
      getState() { return this.state }, getConn() { return { state: 'ready' } }, hasRunningBash() { return false }, getPendingUiCount() { return 0 },
      setRunnerGeneration() {}, async start() { return { ok: true } }, async stop() {}, queueSnapshot() { return { steering: [], followUp: [] } },
      async newSession() { return { ok: true } }, async switchSession(file) { this.state = { ...this.state, sessionId: file, sessionFile: file }; return { ok: true } },
      async setModel() { if (hooks.model) await hooks.model(context, registry); return { ok: !hooks.rejectModel, error: 'fixture model failure' } },
      async send(text) { sent.push({ sessionId: this.state.sessionId, text }); return { ok: true } }
    }) })
    const context = { runners: registry, sameRuntimeEnvelope, getSettings: async () => ({ cwd: work }), sessionHost: {
      validateCwd: async cwd => ({ ok: true, cwd }), projectIdForCwd: () => undefined,
      rememberRunnerSession: async () => { if (hooks.remember) await hooks.remember(context, registry) },
      pushRunnerSnapshot() {}, pushRunners() {}
    } }
    if (hooks.selection) { const originalSelect = registry.select.bind(registry); registry.select = async target => { const result = await originalSelect(target); await hooks.selection(context, registry); return result } }
    if (hooks.guard) registry.guardExecute = () => ({ ok: false, error: 'fixture busy cwd' })
    vm.runInNewContext(dispatchCode, context)
    return { context, registry, sent, dispatch: task => context.dispatch({ ...input, ...task }) }
  }
  let fixture = makeDispatch()
  await fixture.dispatch({})
  verify(fixture.sent.length === 1, 'normal scheduled dispatch succeeds')
  const reuse = async (_, registry) => registry.select({ cwd: work, sessionFile: 'unrelated-session' })
  fixture = makeDispatch({ remember: reuse })
  await assert.rejects(fixture.dispatch({}), /目标会话已变化/); checks++
  verify(fixture.sent.length === 0, 'remember await cannot send into reused session')
  fixture = makeDispatch({ model: reuse })
  await assert.rejects(fixture.dispatch({ model: 'fixture/model' }), /目标会话已变化/); checks++
  verify(fixture.sent.length === 0, 'model await cannot send into reused session')
  fixture = makeDispatch({ selection: async (context, registry) => { registry.select = RunnerRegistry.prototype.select.bind(registry); await reuse(context, registry) } })
  await assert.rejects(fixture.dispatch({}), /目标会话已变化/); checks++
  verify(fixture.sent.length === 0, 'select response identity is checked before capture')
  fixture = makeDispatch({ remember: context => { context.runners = null } })
  await assert.rejects(fixture.dispatch({}), /目标会话已变化/); checks++
  verify(fixture.sent.length === 0, 'registry replacement fails closed')
  fixture = makeDispatch({ guard: true })
  await assert.rejects(fixture.dispatch({}), /busy cwd/); checks++
  verify(fixture.sent.length === 0, 'same cwd guard still enforced')
  fixture = makeDispatch({ rejectModel: true })
  await assert.rejects(fixture.dispatch({ model: 'fixture/model' }), /model failure/); checks++
  verify(fixture.sent.length === 0, 'failed model selection does not dispatch')
  console.log(`Schedule safety: ${checks} passed`)
} finally {
  for (const service of services) service.stop()
  await rm(work, { recursive: true, force: true })
}
