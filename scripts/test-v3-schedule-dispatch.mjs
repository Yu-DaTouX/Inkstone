/**
 * 定时发送安全 + 正式 T 来源回归（v3 WP-51 生产链）。
 *
 * 与 `test-v3-scheduled-runs.mjs`（纯 runs-host）不同：这里把**真实 RunnerRegistry**
 * 与**真实 runs-host** 接到 `src/main/index.ts` 里 `scheduleService.run()` 的**生产
 * 回调**上（AST 提取后原样执行），验证：
 *
 *   · 选择进行中（prepareNewSession 的 await 窗口）先收到 title/state/queued 信号，
 *     会话也不会先分到 S 号，而是走任务 id 的 T 号；
 *   · 发送前 `openScheduled` 用同一 CodeStore / Registry 登记 T，成功沿同一 ctx 收口；
 *   · setModel / send 失败用同一 ctx 收成 failed，不投别的会话；
 *   · 定时会话的子运行沿用父 T 号 `T01·n`；
 *   · 普通 select（不带来源）仍按会话 S 号，不受影响；
 *   · 同一任务再次触发：T 号稳定、runId 独立。
 *
 * 纯本地：esbuild 现场编译 + 假 agent / 隔离临时目录；不发指令、不启动 pi / Electron、
 * 不跑真实模型、不联网。运行视觉 / 真实定时不在本检查范围。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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

/** 从工作区现文提取 scheduleService.run 与 pin 助手，原样在 vm 里执行。 */
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

/** 假 agent：只暴露 RunnerRegistry / runs-host 会读的宿主事实。 */
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
      /** 选择 await 窗口内的早期信号：真 pi 会在标题 / 状态就绪时推这些。 */
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

  /* ── 1. 选择 await 期间的早期信号必须先走 T 号，不能先分 S ── */
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

    /* ── 2. 定时会话的子运行沿用父 T 号（父运行仍在跑） ── */
    host.observeSubagentEvent(
      { id: 'sub-sched', parentSessionId: session1, task: '定时子任务' },
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta' } }
    )
    const child = host.snapshot().runs.find((item) => item.kind === 'subagent')
    verify(!!child && child.code === 'T01·1', '定时子运行继承父 T 号 T01·1')

    host.observerFor({ generation: 1 })({ sessionId: session1 }, { type: 'agent-settled', aborted: false })
    verify(host.snapshot().runs.find((item) => item.runId === run1.runId).phase.kind === 'done', '同 ctx 收成 done')
  }

  /* ── 3. 普通 select（无来源）仍按 S 号，证明上面的 T 不是巧合 ── */
  const normal = await main.registry.select({ cwd: work })
  verify(normal.ok && !!normal.sessionId, '普通 select 成功（复用空闲实例）')
  const normalSession = normal.sessionId
  await waitFor(async () => (await readCodes(dataRoot)).entries.some((e) => e.scopeId === normalSession))
  const codesNormal = await readCodes(dataRoot)
  verify(
    codesNormal.entries.some((e) => e.scopeId === normalSession && e.kind === 'session'),
    '普通选择仍按会话 S 号登记'
  )

  /* ── 4. setModel 失败：同一 ctx 收成 failed，不投别的会话 ── */
  const failing = makeRegistry(RunnerRegistry, host, { setModel: () => ({ ok: false, error: 'fixture 模型不可用' }) })
  const failContext = makeContext(failing.registry, host, sameRuntimeEnvelope, dispatchCode)
  await assert.rejects(() => failContext.dispatch({ ...task, id: 'task-fail', name: '失败任务', model: 'fixture/model' }), /fixture 模型不可用/); checks++
  verify(failing.sent.length === 0, '模型失败时没有发出指令')
  const failedRun = host.snapshot().runs.find((item) => item.phase.kind === 'failed' && item.kind === 'scheduled')
  verify(!!failedRun, '失败的定时运行以同一注册表收成 failed')
  verify(!!failedRun && failedRun.code.startsWith('T'), '失败运行仍持有 T 号')

  /* ── 5. 同一任务再次触发：T 号稳定、runId 独立 ── */
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
