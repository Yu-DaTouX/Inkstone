import assert from 'node:assert/strict'
import { readFile, writeFile, mkdtemp, mkdir, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'
import { build } from 'esbuild'

async function runScheduleSafetyTests() {
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
    const wrongService = make(wrongSchemaFile)
    await wrongService.start()
    wrongService.stop()
    verify(wrongService.list().length === 0, 'invalid entry skipped instead of disabling every task')
    const backups = (await readdir(work)).filter((name) => name.startsWith('wrong-schema.json.invalid-'))
    verify(backups.length === 1 && await readFile(join(work, backups[0]), 'utf8') === wrongSchema, 'invalid entry kept in a backup copy')

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

    let dispatches = 0
    const claimFile = join(work, 'claim.json')
    const claimedService = make(claimFile, { run: async () => { dispatches++; return {} } })
    const claimTask = await claimedService.create(input, 'user')
    const claimDisk = await readFile(claimFile, 'utf8')
    await rm(claimFile)
    await mkdir(claimFile)
    await assert.rejects(claimedService.runNow(claimTask.task.id)); checks++
    verify(dispatches === 0 && !claimedService.list()[0].pendingRun, 'claim save failure never dispatches or publishes claim')
    await rm(claimFile, { recursive: true })
    await writeFile(claimFile, claimDisk)

    const uncertainFile = join(work, 'uncertain.json')
    let durableClaim
    let claimNow = 100000
    const uncertain = make(uncertainFile, { now: () => claimNow, run: async task => {
      dispatches++
      durableClaim = JSON.parse(await readFile(uncertainFile, 'utf8')).tasks[0]
      verify(durableClaim.pendingRun?.id && durableClaim.pendingRun.status === 'claimed', 'claim ID persisted before dispatch')
      verify(durableClaim.pendingRun.scheduledAt === task.nextRunAt && durableClaim.nextRunAt > task.nextRunAt, 'scheduled occurrence consumed before dispatch')
      await rm(uncertainFile)
      await mkdir(uncertainFile)
      return { sessionId: 'possibly-sent' }
    } })
    const uncertainTask = await uncertain.create(input, 'user')
    claimNow = uncertainTask.task.nextRunAt
    await assert.rejects(uncertain.fire(uncertain.list()[0], true)); checks++
    verify(uncertain.list()[0].pendingRun?.status === 'claimed', 'completion save failure retains claim')
    verify(!(await uncertain.runNow(uncertainTask.task.id)).ok, 'unresolved claim is not dispatched again in same process')
    await rm(uncertainFile, { recursive: true })
    await writeFile(uncertainFile, JSON.stringify({ v: 1, tasks: [durableClaim] }))
    const beforeRestart = dispatches
    const restarted = make(uncertainFile, { now: () => 900000, run: async () => { dispatches++; return {} } })
    await restarted.start()
    await restarted.tick()
    verify(dispatches === beforeRestart, 'restart and overdue tick never replay unresolved dispatch')
    const unknown = restarted.list()[0]
    verify(!unknown.enabled && unknown.nextRunAt === undefined && unknown.pendingRun.status === 'unknown' && /未知/.test(unknown.lastError), 'restart persists visible unknown result and pauses automatic execution')
    verify(JSON.parse(await readFile(uncertainFile, 'utf8')).tasks[0].pendingRun.status === 'unknown', 'unknown recovery state persisted')
    verify((await restarted.runNow(unknown.id)).ok && dispatches === beforeRestart + 1, 'explicit manual execution can acknowledge unknown result')

    const crashFile = join(work, 'crash-before-send.json')
    await writeFile(crashFile, JSON.stringify({ v: 1, tasks: [{ ...durableClaim, trigger: { kind: 'once', at: 100001 } }] }))
    const crashed = make(crashFile, { now: () => 900000, run: async () => { dispatches++; return {} } })
    const beforeCrash = dispatches
    await crashed.start()
    verify(dispatches === beforeCrash && !crashed.list()[0].enabled, 'crash between durable claim and dispatch is not auto-replayed, including once tasks')

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
      const runs = { opened: [], failed: [] }
      const runsHost = {
        async openScheduled(record) { runs.opened.push(record); return 'scheduled-' + runs.opened.length },
        failScheduled(handle, message) { runs.failed.push({ handle, message }) }
      }
      const context = { runners: registry, runsHost, sameRuntimeEnvelope, getSettings: async () => ({ cwd: work }), sessionHost: {
        validateCwd: async cwd => ({ ok: true, cwd }), projectIdForCwd: () => undefined,
        rememberRunnerSession: async () => { if (hooks.remember) await hooks.remember(context, registry) },
        pushRunnerSnapshot() {}, pushRunners() {}
      } }
      if (hooks.selection) { const originalSelect = registry.select.bind(registry); registry.select = async target => { const result = await originalSelect(target); await hooks.selection(context, registry); return result } }
      if (hooks.guard) registry.guardExecute = () => ({ ok: false, error: 'fixture busy cwd' })
      vm.runInNewContext(dispatchCode, context)
      return { context, registry, sent, runs, dispatch: task => context.dispatch({ ...input, ...task }) }
    }
    let fixture = makeDispatch()
    await fixture.dispatch({})
    verify(fixture.sent.length === 1, 'normal scheduled dispatch succeeds')
    verify(fixture.runs.opened.length === 1 && fixture.runs.opened[0].title === input.name && fixture.runs.failed.length === 0, 'scheduled run record opened once and not failed')
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
    verify(fixture.runs.failed.length === 1 && fixture.runs.failed[0].handle === 'scheduled-1' && /model failure/.test(fixture.runs.failed[0].message), 'failed dispatch marks its scheduled run record as failed')
    console.log(`Schedule safety: ${checks} passed`)
  } finally {
    for (const service of services) service.stop()
    await rm(work, { recursive: true, force: true })
  }
}

async function runScheduleDispatchTests() {
  let checks = 0
  const verify = (value, label) => { assert.ok(value, label); checks++ }

  async function bundle(file, name, work) {
    const output = join(work, name + '.mjs')
    await build({ entryPoints: [file], outfile: output, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
    return import(pathToFileURL(output).href)
  }

  async function waitFor(predicate, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error('waitFor 超时')
  }

  async function readCodes(root) {
    try {
      return JSON.parse(await readFile(join(root, 'session-codes.json'), 'utf8'))
    } catch {
      return { version: 1, entries: [] }
    }
  }

  async function extractDispatch() {
    const source = await readFile('src/main/index.ts', 'utf8')
    const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    let callback
    const functions = []
    const visit = (node) => {
      if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'scheduleService') {
        callback = node.initializer.arguments[0].properties.find((p) => p.name?.getText(ast) === 'run').initializer.getText(ast)
      }
      if (ts.isFunctionDeclaration(node) && ['pinSendTarget', 'pinnedTargetMatches'].includes(node.name?.text)) {
        functions.push(node.getText(ast))
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
    assert.ok(callback && functions.length === 2, 'index.ts 里能提取到 run 回调与两个 pin 助手')
    return ts.transpileModule(functions.join('\n') + '\nglobalThis.dispatch = ' + callback, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 }
    }).outputText
  }

  const work = await mkdtemp(join(tmpdir(), 'inkstone-v3-dispatch-'))
  const dataRoot = join(work, 'data')
  let seq = 0
  let sessionSeq = 0
  const task = { id: 'task-dispatch', name: '早信号任务', prompt: 'fixture only', trigger: { kind: 'interval', minutes: 5 } }

  function makeRegistry(RunnerRegistry, runsHost, hooks = {}) {
    const sent = []
    const createAgent = (id, cwd, generation) => {
      const observer = runsHost.observerFor({ generation })
      const agent = {
        id,
        state: { sessionId: `pending:${id}`, cwd, isAgentRunning: false, isStreaming: false, isCompacting: false },
        getState() { return this.state },
        getConn() { return { state: 'ready' } },
        hasRunningBash() { return false },
        hasWrittenThisRun() { return true },
        getPendingUiCount() { return 0 },
        setRunnerGeneration(g) { this.generation = g },
        async start() {
          this.state = { ...this.state, sessionId: `sched-real-${++sessionSeq}`, sessionFile: `/s-${sessionSeq}.jsonl` }
          return { ok: true }
        },
        async stop() {},
        queueSnapshot() { return { steering: [], followUp: [] } },
        async newSession() {
          this.state = { ...this.state, sessionId: `sched-real-${++sessionSeq}`, sessionFile: `/s-${sessionSeq}.jsonl` }
          return { ok: true }
        },
        async switchSession(file) {
          this.state = { ...this.state, sessionId: file, sessionFile: file }
          return { ok: true }
        },
        async setModel() { return hooks.setModel ? hooks.setModel() : { ok: true } },
        async send(text) { sent.push({ sessionId: this.state.sessionId, text }); return { ok: true } },
        emitEarly() {
          observer({ sessionId: this.state.sessionId, title: '早标题' }, { type: 'title', title: '早标题' })
          observer({ sessionId: this.state.sessionId }, { type: 'queued', reason: 'scheduled' })
          observer({ sessionId: this.state.sessionId }, { type: 'activity', activity: 'thinking' })
        }
      }
      return agent
    }
    const registry = new RunnerRegistry({
      limit: 4,
      now: () => 1_000,
      createAgent,
      prepareNewSession: async (agent) => { agent.emitEarly(); return { ok: true } },
      onRunnerOrigin: ({ sessionId, generation, origin }) => {
        if (origin) runsHost.bindScheduledOrigin({ scopeId: origin.scopeId, ...(sessionId ? { sessionId } : {}), generation })
        else if (sessionId) runsHost.clearScheduledOrigin({ sessionId, generation })
      }
    })
    return { registry, sent }
  }

  function makeContext(registry, host, sameRuntimeEnvelope, code) {
    const context = {
      runners: registry,
      runsHost: host,
      sameRuntimeEnvelope,
      getSettings: async () => ({ cwd: work }),
      sessionHost: {
        validateCwd: async (cwd) => ({ ok: true, cwd }),
        projectIdForCwd: () => undefined,
        rememberRunnerSession: async () => {},
        pushRunnerSnapshot: () => {},
        pushRunners: () => {}
      }
    }
    vm.runInNewContext(code, context)
    return context
  }

  try {
    const runsHostMod = await bundle('src/main/runs-host.ts', 'runs-host', work)
    const { RunnerRegistry } = await bundle('src/main/runners.ts', 'runners', work)
    const { sameRuntimeEnvelope } = await bundle('src/core/run-state.ts', 'run-state', work)
    const dispatchCode = await extractDispatch()

    const host = await runsHostMod.createRunsHost({
      root: dataRoot,
      push: () => {},
      now: () => 1_000,
      newRunId: () => `run-${++seq}`
    })

    const main = makeRegistry(RunnerRegistry, host)
    const context = makeContext(main.registry, host, sameRuntimeEnvelope, dispatchCode)
    const dispatch = (overrides = {}) => context.dispatch({ ...task, ...overrides })
    await dispatch({})
    verify(main.sent.length === 1, '定时下发成功且只发一次')
    const session1 = main.sent[0].sessionId
    verify(session1.startsWith('sched-real-'), '下发给真实会话')
    await waitFor(async () => (await readCodes(dataRoot)).entries.some((e) => e.scopeId === task.id))
    const run1 = host.snapshot().runs.find((item) => item.sessionId === session1)
    verify(!!run1 && run1.kind === 'scheduled', '早信号登记成 scheduled 运行')
    verify(!!run1 && run1.code === 'T01', '任务 id 分到 T01')
    const codes1 = await readCodes(dataRoot)
    verify(
      !codes1.entries.some((e) => e.scopeId === session1),
      '定时会话在早期信号阶段没有被分到 S 号'
    )
    if (run1) {
      host.observerFor({ generation: 1 })({ sessionId: session1 }, { type: 'agent-start' })
      verify(host.snapshot().runs.find((item) => item.runId === run1.runId).phase.kind === 'running', '同 ctx 进入 running')

      host.observeSubagentEvent(
        { id: 'sub-sched', parentSessionId: session1, task: '定时子任务' },
        { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta' } }
      )
      const child = host.snapshot().runs.find((item) => item.kind === 'subagent')
      verify(!!child && child.code === 'T01·1', '定时子运行继承父 T 号 T01·1')

      host.observerFor({ generation: 1 })({ sessionId: session1 }, { type: 'agent-settled', aborted: false })
      verify(host.snapshot().runs.find((item) => item.runId === run1.runId).phase.kind === 'done', '同 ctx 收成 done')
    }

    const normal = await main.registry.select({ cwd: work })
    verify(normal.ok && !!normal.sessionId, '普通 select 成功（复用空闲实例）')
    const normalSession = normal.sessionId
    await waitFor(async () => (await readCodes(dataRoot)).entries.some((e) => e.scopeId === normalSession))
    const codesNormal = await readCodes(dataRoot)
    verify(
      codesNormal.entries.some((e) => e.scopeId === normalSession && e.kind === 'session'),
      '普通选择仍按会话 S 号登记'
    )

    const failing = makeRegistry(RunnerRegistry, host, { setModel: () => ({ ok: false, error: 'fixture 模型不可用' }) })
    const failContext = makeContext(failing.registry, host, sameRuntimeEnvelope, dispatchCode)
    await assert.rejects(() => failContext.dispatch({ ...task, id: 'task-fail', name: '失败任务', model: 'fixture/model' }), /fixture 模型不可用/); checks++
    verify(failing.sent.length === 0, '模型失败时没有发出指令')
    const failedRun = host.snapshot().runs.find((item) => item.phase.kind === 'failed' && item.kind === 'scheduled')
    verify(!!failedRun, '失败的定时运行以同一注册表收成 failed')
    verify(!!failedRun && failedRun.code.startsWith('T'), '失败运行仍持有 T 号')

    const again = makeRegistry(RunnerRegistry, host)
    const againContext = makeContext(again.registry, host, sameRuntimeEnvelope, dispatchCode)
    await againContext.dispatch({ ...task, id: 'task-dispatch' })
    verify(again.sent.length === 1, '同一任务再次触发成功')
    const againSession = again.sent[0].sessionId
    await waitFor(async () => host.snapshot().runs.some((item) => item.sessionId === againSession))
    const againRun = host.snapshot().runs.find((item) => item.sessionId === againSession)
    verify(!!againRun && againRun.code === 'T01', '同一任务的 T 号稳定')
    verify(!!againRun && !!run1 && againRun.runId !== run1.runId, '同一任务再次触发是独立 runId')
    const finalCodes = await readCodes(dataRoot)
    verify(
      finalCodes.entries.filter((e) => e.scopeId === 'task-dispatch').length === 1,
      '同一任务只持久一条 T 号'
    )
    verify(
      !finalCodes.entries.some((e) => e.scopeId === againSession),
      '再次触发也没有给定时会话分 S 号'
    )

    await host.dispose()
    console.log(`v3-schedule-dispatch: ${checks} passed`)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

async function runScheduleSafetyWiringTests() {
  let checks = 0
  const verify = (value, label) => { assert.ok(value, label); checks++ }

  async function bundle(file, name, work) {
    const output = join(work, name + '.mjs')
    await build({ entryPoints: [file], outfile: output, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
    return import(pathToFileURL(output).href)
  }

  async function extractDispatch() {
    const source = await readFile('src/main/index.ts', 'utf8')
    const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    let callback
    const functions = []
    const visit = (node) => {
      if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'scheduleService') {
        callback = node.initializer.arguments[0].properties.find((p) => p.name?.getText(ast) === 'run').initializer.getText(ast)
      }
      if (ts.isFunctionDeclaration(node) && ['pinSendTarget', 'pinnedTargetMatches'].includes(node.name?.text)) {
        functions.push(node.getText(ast))
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
    assert.ok(callback && functions.length === 2, 'index.ts 里能提取到 run 回调与两个 pin 助手')
    return ts.transpileModule(functions.join('\n') + '\nglobalThis.dispatch = ' + callback, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 }
    }).outputText
  }

  const work = await mkdtemp(join(tmpdir(), 'inkstone-schedule-wiring-'))
  const task = { id: 'task-wiring', name: 'fixture', prompt: 'fixture only', trigger: { kind: 'interval', minutes: 5 } }

  try {
    const { RunnerRegistry } = await bundle('src/main/runners.ts', 'runners', work)
    const { sameRuntimeEnvelope } = await bundle('src/core/run-state.ts', 'run-state', work)
    const dispatchCode = await extractDispatch()

    const makeRunsHost = () => {
      let openSeq = 0
      const calls = []
      return {
        calls,
        bindScheduledOrigin: (input) => calls.push(['bind', input]),
        clearScheduledOrigin: (input) => calls.push(['clear', input]),
        openScheduled: async (input) => {
          calls.push(['open', input])
          return { scopeId: input.scopeId, runId: `run-${++openSeq}`, code: 'T01', context: { sessionId: input.sessionId, kind: 'scheduled' } }
        },
        failScheduled: (handle, message) => calls.push(['fail', handle, message]),
        cancelScheduled: (handle) => calls.push(['cancel', handle])
      }
    }

    const makeDispatch = (hooks = {}) => {
      const sent = []
      const runsHost = makeRunsHost()
      const registry = new RunnerRegistry({
        createAgent: (id, cwd) => ({
          state: { sessionId: 'initial-' + id, cwd, isAgentRunning: false, isStreaming: false, isCompacting: false },
          getState() { return this.state },
          getConn() { return { state: 'ready' } },
          hasRunningBash() { return false },
          hasWrittenThisRun() { return true },
          getPendingUiCount() { return 0 },
          setRunnerGeneration() {},
          async start() { return { ok: true } },
          async stop() {},
          queueSnapshot() { return { steering: [], followUp: [] } },
          async newSession() { return { ok: true } },
          async switchSession(file) { this.state = { ...this.state, sessionId: file, sessionFile: file }; return { ok: true } },
          async setModel() { if (hooks.model) await hooks.model(context, registry); return { ok: !hooks.rejectModel, error: 'fixture model failure' } },
          async send(text) { sent.push({ sessionId: this.state.sessionId, text }); return { ok: true } }
        }),
        onRunnerOrigin: ({ sessionId, generation, origin }) => {
          if (origin) runsHost.bindScheduledOrigin({ scopeId: origin.scopeId, ...(sessionId ? { sessionId } : {}), generation })
          else if (sessionId) runsHost.clearScheduledOrigin({ sessionId, generation })
        }
      })
      const context = {
        runners: registry,
        runsHost,
        sameRuntimeEnvelope,
        getSettings: async () => ({ cwd: work }),
        sessionHost: {
          validateCwd: async (cwd) => ({ ok: true, cwd }),
          projectIdForCwd: () => undefined,
          rememberRunnerSession: async () => { if (hooks.remember) await hooks.remember(context, registry) },
          pushRunnerSnapshot() {},
          pushRunners() {}
        }
      }
      if (hooks.selection) {
        const originalSelect = registry.select.bind(registry)
        registry.select = async (target) => { const result = await originalSelect(target); await hooks.selection(context, registry); return result }
      }
      if (hooks.guard) registry.guardExecute = () => ({ ok: false, error: 'fixture busy cwd' })
      vm.runInNewContext(dispatchCode, context)
      return { context, registry, sent, runsHost, dispatch: (overrides = {}) => context.dispatch({ ...task, ...overrides }) }
    }

    let fixture = makeDispatch()
    await fixture.dispatch({})
    verify(fixture.sent.length === 1, '正常定时下发成功')
    const openIndex = fixture.runsHost.calls.findIndex((call) => call[0] === 'open')
    verify(openIndex >= 0, '发送前调用 openScheduled 登记 T')
    verify(fixture.runsHost.calls.some((call) => call[0] === 'bind'), '选择期同步绑定了定时来源')
    verify(!fixture.runsHost.calls.some((call) => call[0] === 'fail'), '成功路径不调用 failScheduled')

    const reuse = async (_, registry) => registry.select({ cwd: work, sessionFile: 'unrelated-session' })
    fixture = makeDispatch({ remember: reuse })
    await assert.rejects(() => fixture.dispatch({}), /目标会话已变化/); checks++
    verify(fixture.sent.length === 0, 'remember await 换会话时不发送')
    verify(!fixture.runsHost.calls.some((call) => call[0] === 'open'), '目标已变时不登记 T、不投别的会话')

    fixture = makeDispatch({ model: reuse })
    await assert.rejects(() => fixture.dispatch({ model: 'fixture/model' }), /目标会话已变化/); checks++
    verify(fixture.sent.length === 0, 'model await 换会话时不发送')
    verify(fixture.runsHost.calls.some((call) => call[0] === 'fail'), '目标变化后以同一 handle 收成失败')

    fixture = makeDispatch({ selection: async (context, registry) => { registry.select = RunnerRegistry.prototype.select.bind(registry); await reuse(context, registry) } })
    await assert.rejects(() => fixture.dispatch({}), /目标会话已变化/); checks++
    verify(fixture.sent.length === 0, 'select 响应身份不符时不发送')

    fixture = makeDispatch({ remember: (context) => { context.runners = null } })
    await assert.rejects(() => fixture.dispatch({}), /目标会话已变化/); checks++
    verify(fixture.sent.length === 0, 'registry 替换后失败关闭')

    fixture = makeDispatch({ guard: true })
    await assert.rejects(() => fixture.dispatch({}), /busy cwd/); checks++
    verify(fixture.sent.length === 0, '同 cwd 冲突时不发送')
    verify(fixture.runsHost.calls.some((call) => call[0] === 'fail'), 'guard 拒绝后以同一 handle 收成失败')

    fixture = makeDispatch({ rejectModel: true })
    await assert.rejects(() => fixture.dispatch({ model: 'fixture/model' }), /model failure/); checks++
    verify(fixture.sent.length === 0, '模型不可用时不发送')
    verify(fixture.runsHost.calls.some((call) => call[0] === 'fail'), '模型不可用后以同一 handle 收成失败')

    console.log(`v3-schedule-safety-wiring: ${checks} passed`)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

async function runScheduleSendSupportTests() {
  const work = await mkdtemp(join(tmpdir(), 'inkstone-schedule-send-'))
  let checks = 0
  const verify = (value, label) => {
    assert.ok(value, label)
    checks++
  }
  const bundle = async (file, name) => {
    const output = join(work, name + '.mjs')
    await build({ entryPoints: [file], outfile: output, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
    return import(pathToFileURL(output).href)
  }

  const makeRegistry = () => {
    const agents = []
    const registry = new RunnerRegistry({
      limit: 3,
      now: () => 1000,
      createAgent: (id, cwd) => {
        const agent = {
          id,
          state: { sessionId: `pending:${id}`, cwd, isAgentRunning: false, isStreaming: false, isCompacting: false },
          getState() {
            return this.state
          },
          getConn() {
            return { state: 'ready' }
          },
          hasRunningBash() {
            return this.runningBash === true
          },
          hasWrittenThisRun() {
            return true
          },
          getPendingUiCount() {
            return 0
          },
          setRunnerGeneration() {},
          async start() {
            return { ok: true }
          },
          async stop() {},
          queueSnapshot() {
            return { steering: [], followUp: [] }
          },
          async newSession() {
            return { ok: true }
          },
          async switchSession(file) {
            this.state = { ...this.state, sessionId: file, sessionFile: file }
            return { ok: true }
          },
          async setModel() {
            return { ok: true }
          },
          async send() {
            return { ok: true }
          }
        }
        agents.push(agent)
        return agent
      }
    })
    return { registry, agents }
  }

  const { RunnerRegistry } = await bundle('src/main/runners.ts', 'runners')
  const guard = await bundle('src/main/session-send-guard.ts', 'guard')
  const { sameRuntimeEnvelope } = await bundle('src/core/run-state.ts', 'run-state')

  try {
    verify(
      sameRuntimeEnvelope(
        { runId: 'r1', generation: 3, sessionId: 'pending:r1' },
        { runId: 'r1', generation: 3, sessionId: 'real-uuid' }
      ),
      'pending→real 同代视为同一实例'
    )
    verify(
      sameRuntimeEnvelope({ runId: 'r1', generation: 3, sessionId: 'session-a' }, { runId: 'r1', generation: 3, sessionId: 'session-b' }) === false,
      '同代不同真实 sessionId 视为换会话'
    )
    verify(
      sameRuntimeEnvelope({ runId: 'r1', generation: 3, sessionId: 'pending:r1' }, { runId: 'r1', generation: 4, sessionId: 'pending:r1' }) === false,
      'runId 相同但换代必须判为不一致'
    )
    verify(
      sameRuntimeEnvelope({ runId: 'r1', generation: 1, sessionId: 'x' }, { runId: 'r2', generation: 1, sessionId: 'x' }) === false,
      '不同 runId 必须判为不一致'
    )
    verify(sameRuntimeEnvelope(null, { runId: 'r1', generation: 1 }) === false, '缺封套不回退为同实例')

    const lookupTrue = () => true
    verify(guard.guardSameCwdExecute({ runnerId: 'r2', cwd: '/w', selfBusy: false }, lookupTrue).ok === false, '同 cwd 另有忙碌实例拒绝')
    verify(guard.guardSameCwdExecute({ runnerId: 'r1', cwd: '/w', selfBusy: true }, lookupTrue).ok === true, '发起者自己忙放行插话 / 排队')
    verify(guard.guardSameCwdExecute({ runnerId: 'r2', cwd: '', selfBusy: false }, lookupTrue).ok === true, 'cwd 为空交后续既有检查')
    verify(guard.guardSameCwdExecute(null, lookupTrue).ok === true, '无输入放行')
    verify(guard.admissionClaimedBy({ token: 1, runId: 'r2', generation: 5, cwd: '/w' }, 'r2', 5) === true, 'claim 归属同实例同代')
    verify(guard.admissionClaimedBy({ token: 1, runId: 'r2', generation: 5, cwd: '/w' }, 'r2', 6) === false, '换代后旧 claim 失效')
    verify(guard.admissionClaimedBy({ token: 1, runId: 'r2', generation: 5, cwd: '/w' }, 'r1', 5) === false, '别的实例不能认领 claim')

    const { registry, agents } = makeRegistry()
    const cwd = join(work, 'fixture-cwd')
    const first = await registry.select({ cwd })
    verify(first.ok && first.id && first.runId === first.id, '首个实例建成并带身份')
    const r1 = first.id
    const second = await registry.select({ cwd, sessionFile: 'second-session', activate: false })
    verify(second.ok && second.id && second.id !== r1, '同 cwd 另建一个空闲实例')
    const r2 = second.id
    agents[0].state.isAgentRunning = true

    verify(registry.guardExecute(r2).ok === false, '同 cwd busy 冲突：对空闲实例发送被拒')
    verify(registry.guardExecute(r1).ok === true, '同 cwd busy：对忙碌实例自己的插话放行')
    verify(registry.guardExecute('missing').ok === true, '目标不存在交后续检查')

    agents[0].state.isAgentRunning = false
    const claim1 = registry.admitExecute(r1)
    verify(claim1.ok === true, '空闲 cwd 第一个实例取得 claim')
    const claim1Again = registry.admitExecute(r1)
    verify(claim1Again.ok === true && claim1Again.token === claim1.token, '同实例重入返回同一 token')
    const claim2 = registry.admitExecute(r2)
    verify(claim2.ok === false && claim2.error === guard.SAME_CWD_ADMISSION_ERROR, '同 cwd 第二个实例 claim 被明确拒绝')
    verify(registry.confirmExecute(r1, claim1.token) === true, '持有者入队前 confirm 通过')

    registry.releaseExecute(r1, claim1.token)
    verify(registry.confirmExecute(r1, claim1.token) === false, '释放后旧 token 不再 confirm')
    const claim3 = registry.admitExecute(r2)
    verify(claim3.ok === true, '释放后同 cwd 另一个实例可取得 claim')
    verify(registry.confirmExecute(r2, claim3.token) === true, '新持有者 confirm 通过')

    const r2runner = registry.runners.get(r2)
    r2runner.generation += 10
    const claim4 = registry.admitExecute(r2)
    verify(claim4.ok === true && claim4.token !== claim3.token, '换代后旧 claim 被回收并发放新 token')
    verify(registry.confirmExecute(r2, claim3.token) === false, '换代后旧代次 token 拒绝入队')
    verify(registry.confirmExecute(r2, claim4.token) === true, '换代后新 token confirm 通过')
    registry.releaseExecute(r2, claim4.token)
    verify(registry.admitExecute(r1).ok === true, '再次释放后 cwd 重新可用')

    console.log(`Schedule send support: ${checks} passed`)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

async function compile(entry, outfile) {
  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  return import(pathToFileURL(outfile).href)
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('waitFor 超时')
}

async function readCodes(root) {
  try {
    return JSON.parse(await readFile(join(root, 'session-codes.json'), 'utf8'))
  } catch {
    return { version: 1, entries: [] }
  }
}

async function readHistory(root) {
  const dir = join(root, 'runs')
  let names
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const records = []
  for (const name of names.filter((item) => item.endsWith('.jsonl'))) {
    const text = await readFile(join(dir, name), 'utf8')
    for (const line of text.split('\n')) {
      if (line.trim()) records.push(JSON.parse(line))
    }
  }
  return records
}

async function runScheduledRunsTests() {
  const dir = await mkdtemp(join(tmpdir(), 'inkstone-v3-scheduled-'))
  try {
    const origin = await compile('src/main/runs/scheduled-origin.ts', join(dir, 'origin.mjs'))
    const hostMod = await compile('src/main/runs-host.ts', join(dir, 'host.mjs'))

    assert.equal(origin.normalizeScheduledOrigin('  '), null)
    assert.equal(origin.normalizeScheduledOrigin(undefined), null)
    assert.deepEqual(origin.normalizeScheduledOrigin(' task '), { kind: 'scheduled', scopeId: 'task' })
    const built = origin.scheduledRunContext(
      { sessionId: 's', sessionPath: '/p.jsonl', title: 'T', model: { provider: 'p', id: 'm', label: 'M' }, generation: 3 },
      { kind: 'scheduled', scopeId: 'task' },
      { code: 'T01', runId: 'run-x' }
    )
    assert.equal(built.kind, 'scheduled')
    assert.equal(built.scopeId, 'task')
    assert.equal(built.code, 'T01')
    assert.equal(built.runId, 'run-x')
    assert.equal(built.sessionId, 's')
    assert.equal(built.generation, 3)
    assert.equal(built.sessionPath, '/p.jsonl')

    const table = new origin.ScheduledOriginTable()
    table.bind({ kind: 'scheduled', scopeId: 't1' }, { sessionId: 's1', generation: 7 })
    assert.equal(table.resolve({ sessionId: 's1' }).scopeId, 't1')
    assert.equal(table.resolve({ generation: 7 }).scopeId, 't1')
    table.bind({ kind: 'scheduled', scopeId: 't2' }, { generation: 9 })
    assert.equal(table.resolve({ sessionId: 'other', generation: 9 }), undefined, '会话没绑定时不能用代次兜底')
    assert.equal(table.resolve({ generation: 9 }).scopeId, 't2')
    table.clear({ sessionId: 's1' })
    assert.equal(table.resolve({ sessionId: 's1' }), undefined)
    assert.equal(table.resolve({ generation: 7 }).scopeId, 't1', '清除会话键不动代次键')
    table.reset()
    assert.equal(table.size(), 0)

    const root = join(dir, 'data')
    const pushes = []
    let seq = 0
    let now = 1_000
    const host = await hostMod.createRunsHost({
      root,
      push: (msg) => pushes.push(msg),
      now: () => now,
      newRunId: () => `run-${++seq}`
    })

    const schedObs = host.observerFor({ generation: 11 })
    const handle = await host.openScheduled({ scopeId: 'task-a', sessionId: 'sched-1', generation: 11, title: '每日任务' })
    assert.equal(handle.code, 'T01')
    assert.equal(handle.context.kind, 'scheduled')
    assert.equal(handle.context.scopeId, 'task-a')
    let run = host.snapshot().runs.find((item) => item.runId === handle.runId)
    assert.equal(run.kind, 'scheduled')
    assert.equal(run.code, 'T01')
    assert.equal(run.sessionId, 'sched-1')
    assert.equal(run.phase.kind, 'queued', '发送前先登记为 scheduled 排队，不冒充会话运行')
    assert.equal(host.snapshot().runs.filter((item) => item.kind === 'scheduled').length, 1)

    schedObs({ sessionId: 'sched-1', title: '每日任务' }, { type: 'title', title: '每日任务' })
    run = host.snapshot().runs.find((item) => item.runId === handle.runId)
    assert.equal(run.code, 'T01')
    let codeDoc = await readCodes(root)
    assert.ok(
      !codeDoc.entries.some((entry) => entry.scopeId === 'sched-1'),
      '定时会话不得先被分配 S 号'
    )
    assert.deepEqual(
      codeDoc.entries.filter((entry) => entry.scopeId === 'task-a').map((entry) => [entry.kind, entry.code]),
      [['scheduled', 'T01']],
      '任务 id 只持久一条 kind:scheduled 的 T 号'
    )

    now = 2_000
    schedObs({ sessionId: 'sched-1' }, { type: 'agent-start' })
    assert.equal(host.snapshot().runs.find((item) => item.runId === handle.runId).phase.kind, 'running')
    now = 2_500
    host.observeSubagentEvent(
      { id: 'sub-sched', parentSessionId: 'sched-1', task: '定时子任务' },
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta' } }
    )
    const schedChild = host.snapshot().runs.find((item) => item.kind === 'subagent')
    assert.equal(schedChild.code, 'T01·1', '定时会话的子运行沿用父 T 号')
    assert.equal(schedChild.parentRunId, handle.runId)

    const normalObs = host.observerFor({ generation: 12 })
    normalObs({ sessionId: 'normal-1', title: '普通会话' }, { type: 'agent-start' })
    await waitFor(() => host.snapshot().runs.some((item) => item.sessionId === 'normal-1'))
    const normalRun = host.snapshot().runs.find((item) => item.sessionId === 'normal-1')
    assert.equal(normalRun.code, 'S1')
    host.observeSubagentEvent(
      { id: 'sub-normal', parentSessionId: 'normal-1', task: '普通子任务' },
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta' } }
    )
    assert.equal(host.snapshot().runs.find((item) => item.code === 'S1·1').code, 'S1·1')

    now = 3_000
    schedObs({ sessionId: 'sched-1' }, { type: 'agent-settled', aborted: false })
    run = host.snapshot().runs.find((item) => item.runId === handle.runId)
    assert.equal(run.phase.kind, 'done')

    const before = host.snapshot().runs.length
    schedObs({ sessionId: 'sched-1' }, { type: 'tool-end', isWrite: false })
    schedObs({ sessionId: 'sched-1' }, { type: 'agent-start' })
    assert.equal(host.snapshot().runs.length, before, '迟到信号不能重开定时运行')
    assert.equal(host.snapshot().runs.find((item) => item.runId === handle.runId).phase.kind, 'done')
    codeDoc = await readCodes(root)
    assert.ok(!codeDoc.entries.some((entry) => entry.scopeId === 'sched-1'), '迟到事件也不该给定时会话分 S 号')

    host.clearScheduledOrigin({ sessionId: 'sched-1' })
    schedObs({ sessionId: 'sched-1' }, { type: 'agent-start' })
    await waitFor(() => host.snapshot().runs.some((item) => item.sessionId === 'sched-1' && item.kind === 'session'))
    const resumed = host.snapshot().runs.find((item) => item.sessionId === 'sched-1' && item.kind === 'session')
    assert.equal(resumed.code, 'S2', '清除定时来源后才按普通会话编号')

    const failed = await host.openScheduled({ scopeId: 'task-fail', sessionId: 'sched-2', generation: 13 })
    assert.equal(failed.code, 'T02')
    host.failScheduled(failed, '指令没有发出')
    const failedRun = host.snapshot().runs.find((item) => item.runId === failed.runId)
    assert.equal(failedRun.phase.kind, 'failed')
    assert.equal(failedRun.phase.cause, 'host')

    const again = await host.openScheduled({ scopeId: 'task-a', sessionId: 'sched-3', generation: 14 })
    assert.equal(again.code, 'T01', '同一任务的 T 号稳定')
    assert.notEqual(again.runId, handle.runId, '再次触发是一个独立运行实例')
    const againRun = host.snapshot().runs.find((item) => item.runId === again.runId)
    assert.equal(againRun.phase.kind, 'queued')
    assert.equal(host.snapshot().runs.find((item) => item.runId === handle.runId).phase.kind, 'done', '旧运行状态不被新运行改写')
    host.cancelScheduled(again)
    assert.equal(host.snapshot().runs.find((item) => item.runId === again.runId).phase.kind, 'stopped')

    const lazyObs = host.observerFor({ generation: 15 })
    host.bindScheduledOrigin({ scopeId: 'task-lazy', sessionId: 'sched-lazy' })
    lazyObs({ sessionId: 'sched-lazy', title: '懒登记任务' }, { type: 'agent-start' })
    await waitFor(() => host.snapshot().runs.some((item) => item.sessionId === 'sched-lazy'))
    const lazyRun = host.snapshot().runs.find((item) => item.sessionId === 'sched-lazy')
    assert.equal(lazyRun.kind, 'scheduled')
    assert.equal(lazyRun.code, 'T03')
    codeDoc = await readCodes(root)
    assert.ok(!codeDoc.entries.some((entry) => entry.scopeId === 'sched-lazy'), '懒登记也不给会话分 S')

    const byScope = new Map(codeDoc.entries.map((entry) => [entry.scopeId, entry]))
    assert.equal(byScope.get('task-a').code, 'T01')
    assert.equal(byScope.get('task-a').kind, 'scheduled')
    assert.equal(byScope.get('task-fail').code, 'T02')
    assert.equal(byScope.get('task-lazy').code, 'T03')
    assert.equal(byScope.get('normal-1').code, 'S1')
    assert.equal(byScope.get('normal-1').kind, 'session')

    now = 4_000
    normalObs({ sessionId: 'normal-1' }, { type: 'agent-settled', aborted: false })
    await host.dispose()

    const host2 = await hostMod.createRunsHost({ root, push: () => {}, now: () => now, newRunId: () => `run2-${++seq}` })
    const restarted = await host2.openScheduled({ scopeId: 'task-a', sessionId: 'sched-restart' })
    assert.equal(restarted.code, 'T01', '重启后同一任务仍是同一个 T 号')
    assert.equal(restarted.context.kind, 'scheduled')
    host2.cancelScheduled(restarted)
    await host2.dispose()

    const history = await readHistory(root)
    const scheduledHistory = history.filter((record) => record.kind === 'scheduled')
    assert.ok(scheduledHistory.some((record) => record.code === 'T01' && record.terminal === 'done'))
    assert.ok(scheduledHistory.some((record) => record.code === 'T02' && record.terminal === 'failed'))
    assert.ok(history.some((record) => record.kind === 'session' && record.code === 'S1'))

    console.log('v3-scheduled-runs: 全部通过')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runScheduleSafetyTests()
  await runScheduleDispatchTests()
  await runScheduleSafetyWiringTests()
  await runScheduleSendSupportTests()
  await runScheduledRunsTests()
}
