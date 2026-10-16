import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build, transform } from '../node_modules/esbuild/lib/main.js'
import ts from 'typescript'
import { runComposerDraftOwnershipTests } from './test-composer-draft-ownership.mjs'

const GOAL_COORDINATOR_STUB = `
export function defaultWorkMode() { return { mode: 'standard', revision: 0 } }
export function workModeKeyFor(id) { return globalThis.__yanEdgeHarness.key }
export async function resolveWorkMode(id) { return globalThis.__yanEdgeHarness.mode }
export async function pushWorkMode(id) {
  globalThis.__yanEdgeHarness.pushes.push('work-mode:' + id)
  return globalThis.__yanEdgeHarness.mode
}
export async function pushGoal(id) { globalThis.__yanEdgeHarness.pushes.push('goal:' + id) }
export async function cancelGoalResume(id) {}
export const goals = {
  async load() { globalThis.__yanEdgeHarness.goalLoads += 1 },
  state(key) { return globalThis.__yanEdgeHarness.goal },
  async approveReadyReview(key, input) {
    globalThis.__yanEdgeHarness.approveCalls.push({ key, input })
    return globalThis.__yanEdgeHarness.approveResult
  },
  async setReadyApprovalMode() { return { ok: false, code: 'unused', goal: globalThis.__yanEdgeHarness.goal } },
  async modifyReadyReview() { return { ok: false, code: 'unused', goal: globalThis.__yanEdgeHarness.goal } },
  async cancelReadyReview() { return globalThis.__yanEdgeHarness.goal },
  async setPaused() { return globalThis.__yanEdgeHarness.goal },
  async startPursued() { return globalThis.__yanEdgeHarness.goal }
}
`

const HANDOFF_COORDINATOR_STUB = `
export const HANDOFF_COMMIT_ENABLED = false
export const HANDOFF_THRESHOLD_EFFECTIVE = 0
export const handoffPending = new Map()
export const handoffLastCheck = new Map()
export async function abandonHandoff() {}
`

const workModeSource = await readFile(new URL('../src/main/work-mode-service.ts', import.meta.url), 'utf8')
const workModeTree = ts.createSourceFile('work-mode-service.ts', workModeSource, ts.ScriptTarget.Latest, true)
const workModeHelpers = await transform(['sanitizeWorkModeKey', 'normalizeSessionFileKey', 'sameWorkModeIdentity'].map(name => {
  const node = workModeTree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
  if (!node) throw new Error(`Missing production helper: ${name}`)
  return node.getText(workModeTree)
}).join('\n'), { loader: 'ts', format: 'esm' })
const WORK_MODE_SERVICE_STUB = `
${workModeHelpers.code}
export async function writeWorkModeSnapshot(runtimeKey, state, budget, profile, globalFrequency, permissions, options) {
  if (options?.guard && !(await options.guard())) return null;
}
`

function goalIpcStubPlugin() {
  const sources = {
    'goal-coordinator': GOAL_COORDINATOR_STUB,
    'handoff-coordinator': HANDOFF_COORDINATOR_STUB,
    'work-mode-service': WORK_MODE_SERVICE_STUB
  }
  return {
    name: 'yan-goal-ipc-stubs',
    setup(buildApi) {
      buildApi.onResolve({ filter: /(goal-coordinator|handoff-coordinator|work-mode-service)$/ }, (args) => ({
        path: args.path.split('/').pop(),
        namespace: 'yan-goal-ipc-stub'
      }))
      buildApi.onLoad({ filter: /.*/, namespace: 'yan-goal-ipc-stub' }, (args) => ({
        contents: sources[args.path],
        loader: 'js'
      }))
    }
  }
}

export async function runSessionConcurrencyFinalEdgesTests(ok) {
  const section = (name) => console.log(`\n## ${name}`)
  const temp = await mkdtemp(join(tmpdir(), 'yan-final-edges-'))

  const bundleToFile = async (entry, name, plugins) => {
    const outfile = join(temp, name)
    await build({
      entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'node',
      logLevel: 'silent',
      ...(plugins ? { plugins } : {})
    })
    return import(pathToFileURL(outfile).href)
  }

  const bundleInMemory = async (entry) => {
    const compiled = await build({
      entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
      bundle: true,
      platform: 'node',
      format: 'esm',
      write: false
    })
    const code = Buffer.from(compiled.outputFiles[0].text).toString('base64')
    return import(`data:text/javascript;base64,${code}`)
  }

  const { submitComposerInput } = await bundleToFile('../src/renderer/src/lib/composer-submit.ts', 'composer-submit.mjs')

  function makePort(overrides = {}) {
    const calls = { runBash: [], clearText: 0, clearAll: 0, restoreText: [], restoreAttachments: [], notify: [] }
    const state = { text: overrides.text ?? '', attachments: overrides.attachments ?? [] }
    const port = {
      get text() {
        return state.text
      },
      get attachments() {
        return state.attachments
      },
      commands: [],
      models: [],
      t: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key),
      actions: {
        runBash: async (cmd, options) => {
          calls.runBash.push({ cmd, options })
          return overrides.runBash ? overrides.runBash(cmd, options) : { ok: true }
        },
        openSettings: () => {},
        newSession: () => {},
        compact: () => {},
        openBrowser: () => {},
        setModel: () => {},
        exportHtml: () => {},
        copyLastReply: () => {},
        clone: () => {},
        setManualTitle: () => {},
        setThinking: () => {},
        notify: (level, text) => calls.notify.push({ level, text })
      },
      session: null,
      thinkingLevels: [],
      roundRunning: false,
      isCompacting: false,
      clearText: () => {
        calls.clearText += 1
        state.text = ''
      },
      clearAll: () => {
        calls.clearAll += 1
        state.text = ''
        state.attachments = []
      },
      restoreText: (raw) => {
        calls.restoreText.push(raw)
        state.text = state.text ? `${raw}\n${state.text}` : raw
      },
      restoreAttachments: (saved) => {
        calls.restoreAttachments.push(saved)
        state.attachments = [...saved, ...state.attachments.filter((item) => !saved.some((kept) => kept.id === item.id))]
      },
      readAttachments: () => state.attachments,
      send: async () => true,
      holdSend: () => {},
      focusComposer: () => {}
    }
    return { port, calls, state }
  }

  const attachment = (id) => ({ id, kind: 'image', name: `${id}.png`, data: 'AAAA', mimeType: 'image/png', size: 4 })

  section('composer-submit：`!` 成功只清文字')
  {
    const { port, calls, state } = makePort({ text: '!echo hi', attachments: [attachment('a1')] })
    const outcome = await submitComposerInput(port)
    ok(outcome === 'handled', '`!` 返回 handled', outcome)
    ok(calls.runBash.length === 1 && calls.runBash[0].cmd === 'echo hi', '命令去掉前缀与空白后直执行', JSON.stringify(calls.runBash[0]))
    ok(calls.runBash[0].options === undefined, '单个 `!` 不带 excludeFromContext', JSON.stringify(calls.runBash[0].options))
    ok(calls.clearText === 1 && calls.clearAll === 0, '成功只清文字、不动附件', JSON.stringify(calls))
    ok(state.text === '', '成功后草稿清空')
    ok(calls.restoreText.length === 0 && calls.restoreAttachments.length === 0, '成功不恢复')
    ok(state.attachments.length === 1, '附件留在输入框（沿用既有行为）')
  }

  section('composer-submit：`!!` 保留 excludeFromContext 且失败恢复')
  {
    const { port, calls, state } = makePort({
      text: '!!rm -rf build',
      attachments: [attachment('a1')],
      runBash: () => ({ ok: false, error: '同 cwd 冲突' })
    })
    const outcome = await submitComposerInput(port)
    ok(outcome === 'handled', '`!!` 失败仍返回 handled', outcome)
    ok(calls.runBash[0].cmd === 'rm -rf build', '`!!` 去掉两个前缀', calls.runBash[0].cmd)
    ok(calls.runBash[0].options?.excludeFromContext === true, '`!!` 的 excludeFromContext 不丢', JSON.stringify(calls.runBash[0].options))
    ok(state.text === '!!rm -rf build', '失败把命令原文放回草稿', JSON.stringify(state.text))
    ok(calls.restoreAttachments.length === 1, '失败把附件快照交回恢复', JSON.stringify(calls.restoreAttachments))
    ok(state.attachments.filter((a) => a.id === 'a1').length === 1, '附件恢复不产生重复', JSON.stringify(state.attachments))
  }

  section('composer-submit：runBash 抛异常也恢复')
  {
    const { port, calls, state } = makePort({
      text: '!deploy',
      attachments: [attachment('a1')],
      runBash: () => {
        throw new Error('通道断开')
      }
    })
    const outcome = await submitComposerInput(port)
    ok(outcome === 'handled', '抛异常仍返回 handled', outcome)
    ok(state.text === '!deploy', '抛异常把命令原文放回草稿', JSON.stringify(state.text))
    ok(calls.restoreAttachments.length === 1, '抛异常把附件放回')
    ok(calls.notify.some((n) => n.level === 'error' && /通道断开/.test(n.text)), '抛异常给出错误提示', JSON.stringify(calls.notify))
  }

  section('composer-submit：旧 void 返回视为已执行')
  {
    const { port, calls, state } = makePort({ text: '!whatever', runBash: () => undefined })
    const outcome = await submitComposerInput(port)
    ok(outcome === 'handled', 'void 返回仍 handled', outcome)
    ok(calls.clearText === 1 && calls.restoreText.length === 0, '旧实现不恢复，保持原行为', JSON.stringify(calls))
    ok(state.text === '', '旧实现成功后草稿清空')
  }

  section('composer-submit：恢复不覆盖 await 期间的新草稿')
  {
    const { port, calls, state } = makePort({
      text: '!long-task',
      runBash: () => {
        state.text = '用户新敲的内容'
        return { ok: false, error: '失败' }
      }
    })
    await submitComposerInput(port)
    ok(state.text.includes('!long-task') && state.text.includes('用户新敲的内容'), '恢复是追加式：命令与 await 期间的新草稿都在', JSON.stringify(state.text))
    ok(calls.restoreText[0] === '!long-task', '恢复的正是原始命令原文', JSON.stringify(calls.restoreText))
  }

  section('composer-submit：只有 `!` 没有命令时不执行')
  {
    const { port, calls } = makePort({ text: '!' })
    const outcome = await submitComposerInput(port)
    ok(outcome === 'empty', '空命令返回 empty', outcome)
    ok(calls.runBash.length === 0 && calls.clearText === 0, '空命令不调用 runBash、不清草稿', JSON.stringify(calls))
  }

  const { RunnerRegistry } = await bundleInMemory('../src/main/runners.ts')
  const { registerGoalIpc } = await bundleToFile('../src/main/ipc/goal-ipc.ts', 'goal-ipc.mjs', [goalIpcStubPlugin()])

  const harness = {
    key: 'C:/proj/a.jsonl',
    mode: { mode: 'clarify', revision: 7 },
    goal: null,
    approveResult: null,
    goalLoads: 0,
    approveCalls: [],
    setCalls: [],
    sendCalls: [],
    guardCalls: [],
    pushes: []
  }
  globalThis.__yanEdgeHarness = harness

  const pendingGoal = (revision = 3, transitionId = 't1') => ({
    goalId: 'g1',
    revision,
    pendingReady: {
      transitionId,
      goalRevision: revision,
      modeRevision: 7,
      understanding: { goal: '目标', deliverable: '交付物', scope: '范围', constraints: '约束', acceptance: '验收' }
    },
    readyApproval: 'review',
    phase: 'clarify'
  })

  function makeAgent() {
    const calls = { stop: 0 }
    return {
      calls,
      id: undefined,
      cwd: undefined,
      state: { sessionId: 's', sessionFile: undefined, isAgentRunning: false, isStreaming: false, isCompacting: false, cwd: 'C:/p' },
      pending: 0,
      bashRunning: false,
      queue: { steering: [], followUp: [] },
      getState() {
        return this.state
      },
      getPendingUiCount() {
        return this.pending
      },
      hasRunningBash() {
        return this.bashRunning
      },
      getConn() {
        return { state: 'ready', detail: '' }
      },
      setRunnerGeneration(generation) {
        this.capabilityGeneration = generation
      },
      async start() {
        return { ok: true }
      },
      async stop() {
        calls.stop += 1
      },
      async switchSession(path) {
        this.state = { ...this.state, sessionFile: path }
        return { ok: true }
      },
      async newSession() {
        this.state = { ...this.state, sessionFile: undefined }
        return { ok: true }
      },
      queueSnapshot() {
        return structuredClone(this.queue)
      },
      async restoreQueueSnapshot(snapshot) {
        this.queue = structuredClone(snapshot)
        return { ok: true }
      },
      async send(text, images, mode) {
        harness.sendCalls.push({ text, images, mode })
        return { ok: true }
      }
    }
  }

  async function makeRegistry({ busyBackground = false } = {}) {
    const reg = new RunnerRegistry({
      limit: 3,
      createAgent: (id, cwd, generation) => {
        const agent = makeAgent()
        agent.id = id
        agent.cwd = cwd
        agent.state = { ...agent.state, cwd }
        if (generation !== undefined) agent.capabilityGeneration = generation
        return agent
      }
    })
    const first = await reg.select({ cwd: 'C:/proj', sessionFile: 'C:/proj/a.jsonl' })
    const second = await reg.select({ cwd: 'C:/proj', sessionFile: 'C:/proj/b.jsonl', activate: false })
    if (busyBackground) {
      const bg = reg.agentOf(second.id)
      bg.state = { ...bg.state, isAgentRunning: true }
    }
    return { reg, activeId: first.id, backgroundId: second.id }
  }

  const wrapRegistry = (reg) => ({
    activeRunner: () => reg.activeRunner(),
    agentOf: (id) => reg.agentOf(id),
    guardExecute: (id) => {
      harness.guardCalls.push(id)
      return reg.guardExecute(id)
    }
  })

  const handlers = new Map()
  const ipc = {
    handlers,
    handle(channel, fn) {
      handlers.set(channel, fn)
    },
    invoke(channel, ...args) {
      const fn = handlers.get(channel)
      if (!fn) throw new Error(`no handler for ${channel}`)
      return fn(...args)
    }
  }
  const state = { registry: null }
  registerGoalIpc(ipc, {
    registry: () => state.registry,
    workModes: {
      async load() {},
      async set(key, mode, revision) {
        harness.setCalls.push({ key, mode, revision })
        return { ok: true, state: { mode, revision: revision + 1 } }
      }
    },
    handoffs: {},
    handoffTransactions: {},
    sessionChains: {},
    handoffDiag: { load: async () => {}, recent: () => [], record: () => {} },
    pushFrom: (id, msg) => harness.pushes.push(msg.ch),
    scheduleSessionWork: async () => {}
  })

  function resetHarness(goal, approveResult) {
    harness.goal = goal
    harness.approveResult = approveResult
    harness.goalLoads = 0
    harness.approveCalls = []
    harness.setCalls = []
    harness.sendCalls = []
    harness.guardCalls = []
    harness.pushes = []
    harness.mode = { mode: 'clarify', revision: 7 }
  }

  section('goal-ipc：同 cwd 另有忙碌实例时批准前拒绝，不转移计划 / 模式')
  {
    const { reg, activeId, backgroundId } = await makeRegistry({ busyBackground: true })
    state.registry = wrapRegistry(reg)
    const goal = pendingGoal()
    resetHarness(goal, { ok: true, replayed: false, goal: { ...goal, revision: 4, pendingReady: null } })

    const res = await ipc.invoke('yan:approveGoalReady', {
      runnerId: activeId,
      transitionId: 't1',
      goalRevision: 3,
      modeRevision: 7
    })

    ok(res.ok === false, '复核拒绝时批准返回失败', JSON.stringify(res))
    ok(typeof res.error === 'string' && res.error.length > 0, '拒绝带可读原因', res.error)
    ok(harness.guardCalls.length === 1 && harness.guardCalls[0] === activeId, '复核针对绑定的 active runner', JSON.stringify(harness.guardCalls))
    ok(harness.approveCalls.length === 0, '拒绝时没有消费 pendingReady（可再试）', JSON.stringify(harness.approveCalls))
    ok(harness.setCalls.length === 0, '拒绝时没有把工作模式转成已执行', JSON.stringify(harness.setCalls))
    ok(harness.sendCalls.length === 0, '拒绝时没有发出启动消息')
    ok(res.goal.pendingReady?.transitionId === 't1' && res.goal.revision === 3, '返回的目标原样保留，不丢目标', JSON.stringify(res.goal))
    ok(reg.agentOf(backgroundId).state.isAgentRunning === true, '拒绝没有停掉同 cwd 的忙碌实例')
  }

  section('goal-ipc：无同 cwd 冲突时正常批准并发送')
  {
    const { reg, activeId } = await makeRegistry()
    state.registry = wrapRegistry(reg)
    const goal = pendingGoal()
    resetHarness(goal, { ok: true, replayed: false, goal: { ...goal, revision: 4, pendingReady: null } })

    const res = await ipc.invoke('yan:approveGoalReady', {
      runnerId: activeId,
      transitionId: 't1',
      goalRevision: 3,
      modeRevision: 7
    })

    ok(res.ok === true && res.replayed === false, '放行时批准成功', JSON.stringify(res))
    ok(harness.approveCalls.length === 1 && harness.approveCalls[0].input.transitionId === 't1', '消费一次待审计划', JSON.stringify(harness.approveCalls))
    ok(harness.setCalls.length === 1 && harness.setCalls[0].mode === 'standard', '模式切到 standard', JSON.stringify(harness.setCalls))
    ok(harness.sendCalls.length === 1 && /批准的计划开始执行/.test(harness.sendCalls[0].text), '发出与桌面一致的启动消息', JSON.stringify(harness.sendCalls))
    ok(res.started === true, '回传 started=true', JSON.stringify(res))
  }

  section('goal-ipc：复核期间切换会话则按陈旧身份拒绝')
  {
    let call = 0
    state.registry = {
      activeRunner: () => ({ id: call++ === 0 ? 'r1' : 'r2' }),
      agentOf: () => ({ send: async () => ({ ok: true }) }),
      guardExecute: () => ({ ok: true })
    }
    const goal = pendingGoal()
    resetHarness(goal, { ok: true, replayed: false, goal: { ...goal, revision: 4, pendingReady: null } })

    const res = await ipc.invoke('yan:approveGoalReady', {
      runnerId: 'r1',
      transitionId: 't1',
      goalRevision: 3,
      modeRevision: 7
    })

    ok(res.ok === false && res.error === 'stale_runner', '切走后批准按陈旧身份拒绝', JSON.stringify(res))
    ok(harness.approveCalls.length === 0 && harness.setCalls.length === 0 && harness.sendCalls.length === 0, '陈旧身份不转移、不发送', JSON.stringify({ a: harness.approveCalls, s: harness.setCalls, send: harness.sendCalls }))
    ok(res.goal.pendingReady?.transitionId === 't1', '目标仍保留待审计划')
  }

  section('goal-ipc：目标 revision 不符时在复核前就拒绝')
  {
    const { reg, activeId } = await makeRegistry()
    state.registry = wrapRegistry(reg)
    const goal = pendingGoal(3)
    resetHarness(goal, null)

    const res = await ipc.invoke('yan:approveGoalReady', {
      runnerId: activeId,
      transitionId: 't1',
      goalRevision: 2,
      modeRevision: 7
    })

    ok(res.ok === false && res.error === 'stale_goal', '陈旧 goalRevision 被拒不进入转移', JSON.stringify(res))
    ok(harness.guardCalls.length === 0, 'revision 不符时不消耗复核', JSON.stringify(harness.guardCalls))
  }

  section('composer 草稿归属：真实 store 驱动 A→B→失败→回 A 等场景')
  await runComposerDraftOwnershipTests(ok)

  delete globalThis.__yanEdgeHarness
}

async function main() {
  let passed = 0
  let failed = 0
  await runSessionConcurrencyFinalEdgesTests((cond, label, detail) => {
    if (cond) {
      passed += 1
      console.log(`  [ok] ${label}`)
    } else {
      failed += 1
      console.error(`  [FAIL] ${label}${detail === undefined ? '' : ` -> ${detail}`}`)
    }
  })
  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main()
