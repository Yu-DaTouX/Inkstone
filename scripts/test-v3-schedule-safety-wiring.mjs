import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'
import { build } from 'esbuild'

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

  const agent = await readFile('src/main/agent.ts', 'utf8')
  verify(agent.includes("import type { ExecuteAdmissionPort } from './session-send-guard'"), 'agent.ts 引入了 ExecuteAdmissionPort')
  verify((agent.match(/const admission = this\.claimExecutionAdmission\(\)/g) ?? []).length === 4, 'send / steer / followUp / runBash 四处同步 claim')
  for (const name of ['sendAdmitted', 'steerAdmitted', 'followUpAdmitted', 'runBashAdmitted']) {
    verify(agent.includes(`private async ${name}(`), `agent.ts 提供 ${name} 执行体`)
  }
  verify(agent.includes('if (!this.confirmExecutionAdmission()) throw new Error('), '真正入队前 confirm 生效')
  verify(agent.includes('this.releaseExecutionAdmission()'), 'agent.ts 有 release 接线')
  verify(agent.includes("async stop(): Promise<void> {\n    this.stopping = true\n    this.releaseExecutionAdmission()"), 'stop() 归还执行入场 claim')
  verify(agent.includes('if (this.capabilityOpts.runnerGeneration !== generation) this.releaseExecutionAdmission()'), 'setRunnerGeneration 换代时归还 claim')

  const index = await readFile('src/main/index.ts', 'utf8')
  verify(index.includes('execution: runners?.executionPort(id)'), 'index.ts 按 runner 注入 executionPort(id)')
  verify(index.includes('onRunnerOrigin: ({ sessionId, generation, origin })'), 'index.ts 接线 onRunnerOrigin')
  verify(index.includes("origin: { kind: 'scheduled', scopeId: task.id }"), '定时 select 携带正式 scheduled 来源')
  verify(index.includes('runsHost.openScheduled('), 'index.ts 生产链调用 openScheduled')
  verify(index.includes('runsHost.failScheduled('), 'index.ts 生产链调用 failScheduled')

  console.log(`v3-schedule-safety-wiring: ${checks} passed`)
} finally {
  await rm(work, { recursive: true, force: true })
}
