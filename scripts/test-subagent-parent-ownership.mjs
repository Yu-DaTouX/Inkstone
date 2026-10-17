import fs from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

async function loadBundle(entry, dir, name) {
  const outfile = join(dir, `${name}.mjs`)
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
  return import(pathToFileURL(outfile).href)
}

function mkAgent(sessionId, sessionFile) {
  return {
    state: { sessionId, sessionFile, sessionName: 'n', cwd: undefined, isAgentRunning: false, isStreaming: false, isCompacting: false },
    getState() { return this.state },
    getPendingUiCount() { return 0 },
    hasRunningBash() { return false },
    getConn() { return { state: 'ready' } },
    setRunnerGeneration(g) { this.capabilityGeneration = g },
    async start() { return { ok: true } },
    async stop() {},
    async switchSession(p) { this.state = { ...this.state, sessionFile: p }; return { ok: true } },
    async newSession() { return { ok: true } },
    queueSnapshot() { return { steering: [], followUp: [] } },
    async restoreQueueSnapshot() { return { ok: true } }
  }
}

const setSession = (registry, id, sessionId) => {
  const agent = registry.agentOf(id)
  agent.state = { ...agent.state, sessionId }
}

export async function runSubagentParentOwnershipTests(ok) {
  const check = typeof ok === 'function' ? ok : (condition, label) => { if (!condition) throw new Error(`✗ ${label}`) }
  const dir = await mkdtemp(join(tmpdir(), 'yan-subagent-parent-'))
  try {
    {
      const { subagentOwnerForView, subagentScopeForView } = await loadBundle(
        fileURLToPath(new URL('../src/renderer/src/state/subagent-view.ts', import.meta.url)),
        dir,
        'subagent-view'
      )
      const runners = [
        { id: 'rA', runId: 'rA', sessionId: 'A', sessionFile: 'C:\\proj\\a.jsonl', projectId: 'pA', generation: 3 },
        { id: 'rB', runId: 'rB', sessionId: 'B', sessionFile: 'c:/PROJ/b.jsonl', projectId: 'pB', generation: 7 }
      ]
      const viewB = { peekedSessionId: 'B', peekedPath: null, session: { sessionId: 'A', sessionFile: 'C:/proj/a.jsonl', conversationId: 'A-conv' }, runners }
      const ownerB = subagentOwnerForView(viewB)
      check(ownerB.expectedRuntime?.runId === 'rB', 'B 视图派活归属取 B 的实例（不是 active 的 A）')
      check(ownerB.expectedRuntime?.sessionId === 'B' && ownerB.expectedRuntime?.generation === 7, 'owner 带 B 的稳定 sessionId 与代次')
      check(ownerB.expectedRuntime?.projectId === 'pB', 'owner 带 B 的 projectId')
      check(ownerB.needsRunner === false, 'B 视图有实例时不阻止派活')

      const scopeB = subagentScopeForView(viewB)
      check(scopeB.runIds?.[0] === 'rB' && scopeB.sessionIds.join(',') === 'B', '派活归属与列表归属指向同一视图实例')

      const ownerA = subagentOwnerForView({ peekedSessionId: null, peekedPath: null, session: { sessionId: 'A', sessionFile: 'C:/proj/a.jsonl' }, runners })
      check(ownerA.expectedRuntime?.runId === 'rA' && ownerA.expectedRuntime?.sessionId === 'A', '当前会话 A 派活归属取 A 的实例')

      const noRunner = subagentOwnerForView({ peekedSessionId: 'B', peekedPath: null, session: { sessionId: 'A' }, runners: [runners[0]] })
      check(noRunner.needsRunner === true && noRunner.expectedRuntime === undefined, '有稳定 SID 但无运行实例 → needsRunner（明确不派）')

      const noRunnerPath = subagentOwnerForView({ peekedSessionId: null, peekedPath: 'C:/gone/x.jsonl', session: null, runners })
      check(noRunnerPath.needsRunner === true, '按路径预览找不到实例 → needsRunner')

      const startup = subagentOwnerForView({ peekedSessionId: null, peekedPath: null, session: { sessionId: '' }, runners })
      check(startup.needsRunner === false && startup.expectedRuntime === undefined, '启动早期无身份 → 不带 owner（宿主钉当前父）')

      const pending = subagentOwnerForView({ peekedSessionId: 'pending:rB', peekedPath: null, session: null, runners })
      check(pending.expectedRuntime?.runId === 'rB', 'pending:<runId> 视图按 runId 找到实例')
    }

    {
      const { registerSubagentsIpc } = await loadBundle(
        fileURLToPath(new URL('../src/main/ipc/subagents-ipc.ts', import.meta.url)),
        dir,
        'subagents-ipc'
      )
      const handlers = new Map()
      const ipc = { handle: (channel, fn) => handlers.set(channel, fn) }
      const starts = []
      const contexts = []
      const ctrl = {
        setContext(ctx) { contexts.push(ctx) },
        async start(task, model, mode) { starts.push({ task, model, mode }); return { ok: true, run: { id: 'sub-x' } } }
      }
      const calls = []
      const parentContext = async (owner) => {
        calls.push(owner)
        if (owner && owner.runId === 'missing') throw new Error('子代理父会话已不可用，未派发')
        return { cwd: 'C:/other', parentSessionId: 'B', parentRunId: 'rB', projectId: 'pB' }
      }
      registerSubagentsIpc(ipc, { service: { get: async () => ctrl }, parentContext })
      const start = handlers.get('yan:subagents:start')

      const owner = { sessionId: 'B', runId: 'rB', generation: 7 }
      await start('task B', 'model', 'shared-cwd', owner)
      check(calls.length === 1 && calls[0] === owner, 'IPC 把 expectedRuntime 原样转给 parentContext')
      check(contexts.length === 1 && contexts[0].parentSessionId === 'B' && contexts[0].parentRunId === 'rB', 'controller 收到 B 的父上下文')
      check(starts.length === 1 && starts[0].mode === 'shared-cwd', '定位成功后正常派活一次')

      const failed = await start('task B', 'model', 'shared-cwd', { runId: 'missing' })
      check(failed.ok === false && typeof failed.error === 'string' && failed.error.length > 0, '定位失败返回明确错误')
      check(starts.length === 1 && contexts.length === 1, '定位失败零 spawn、不 setContext（不落到 active）')

      await start('task A', 'model', undefined)
      check(calls.at(-1) === undefined, '不传 owner 时按老调用走当前父（undefined）')
      check(starts.length === 2, '老调用仍能派活（兼容）')
    }

    {
      const indexFile = fileURLToPath(new URL('../src/main/index.ts', import.meta.url))
      const source = await fs.readFile(indexFile, 'utf8')
      const sf = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
      const names = ['normalizeExpectedRuntime', 'targetMatchesExpected', 'resolveExpectedTarget', 'parentContextFromOwner', 'captureDefaultParent', 'parentContextFromCapture', 'resolveSubagentParentContext', 'adoptSubagentParentSessions', 'pushRunners']
      const extracted = names.map((name) => {
        const node = sf.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === name)
        if (!node) throw new Error('Missing ' + name)
        return node.getText(sf)
      }).join('\n')
      const code = ts.transpileModule(extracted, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
      }).outputText

      const runnersBundle = await build({
        entryPoints: [fileURLToPath(new URL('../src/main/runners.ts', import.meta.url))],
        bundle: true,
        platform: 'node',
        format: 'esm',
        write: false
      })
      const { RunnerRegistry } = await import(`data:text/javascript;base64,${Buffer.from(runnersBundle.outputFiles[0].text).toString('base64')}`)

      const registry = new RunnerRegistry({
        limit: 3,
        createAgent: (id, cwd, generation) => {
          const agent = mkAgent(`s-${id}`, undefined)
          agent.state.cwd = cwd
          if (generation !== undefined) agent.capabilityGeneration = generation
          return agent
        }
      })
      const settings = { cwd: 'C:/fallback', projects: [{ id: 'pB', cwd: 'C:/other' }] }
      const runState = await loadBundle(
        fileURLToPath(new URL('../src/core/run-state.ts', import.meta.url)),
        dir,
        'run-state'
      )
      const context = {
        runners: registry,
        sameRuntimeEnvelope: runState.sameRuntimeEnvelope,
        projectIdForCwd: (s, cwd) => s.projects.find((p) => p.cwd === cwd)?.id
      }
      vm.createContext(context)
      vm.runInContext(code, context)
      const { parentContextFromOwner } = context

      const a = await registry.select({ cwd: 'C:/proj', sessionFile: 'C:/proj/A.jsonl' })
      registry.agentOf(a.id).state = { ...registry.agentOf(a.id).state, isAgentRunning: true }
      const b = await registry.select({ cwd: 'C:/other', sessionFile: 'C:/other/B.jsonl' })
      registry.agentOf(a.id).state = { ...registry.agentOf(a.id).state, isAgentRunning: false }
      await registry.select({ cwd: 'C:/proj', sessionFile: 'C:/proj/A.jsonl' })
      check(a.id !== b.id, '前置：A/B 是两个独立 runner', `${a.id} vs ${b.id}`)
      check(registry.activeRunnerId === a.id, '前置：当前 active 是 A')

      setSession(registry, a.id, 'A-real')
      setSession(registry, b.id, 'B-real')
      const runtimeB = registry.runtimeOf(b.id)
      const goodOwner = { sessionId: 'B-real', runId: runtimeB.runId, generation: runtimeB.generation }

      const ctx = parentContextFromOwner(goodOwner, settings)
      check(ctx && ctx.parentRunId === b.id, '显式 owner 解析到 B 的运行实例')
      check(ctx?.parentSessionId === 'B-real', '父 SID 来自同一目标实例（B）')
      check(ctx?.cwd === 'C:/other' && ctx?.projectId === 'pB', '父 cwd / projectId 来自同一目标实例')
      check(ctx?.parentGeneration === runtimeB.generation, '父代次来自同一目标实例（供 pending→真实迁移判定）')
      check(registry.activeRunnerId === a.id, '解析 B 不改变 active（仍停在 A）')

      check(parentContextFromOwner(undefined, settings) === null, '未给 owner → null（由入口走默认路径）')
      check(parentContextFromOwner({}, settings) === null, '缺字段 owner → null')
      check(parentContextFromOwner('B', settings) === null, '非对象 owner → null')
      check(parentContextFromOwner({ runId: 'nope', generation: 1 }, settings) === null, '未知 runId → null')
      check(parentContextFromOwner({ runId: b.id, generation: runtimeB.generation + 5 }, settings) === null, '旧 / 错代次 → null')
      check(parentContextFromOwner({ runId: b.id, sessionId: 'Z-real', generation: runtimeB.generation }, settings) === null, '同 runId 但不同真实 SID → null（不得归 B）')

      setSession(registry, b.id, `pending:${b.id}`)
      const pendingOwner = { sessionId: `pending:${b.id}`, runId: b.id, generation: runtimeB.generation }
      setSession(registry, b.id, 'B-real')
      const migrated = parentContextFromOwner(pendingOwner, settings)
      check(migrated?.parentRunId === b.id && migrated?.parentSessionId === 'B-real', 'pending → 真实 uuid 同代次迁移可用，父 SID 用当前值')

      setSession(registry, b.id, 'B-real')
      const captured = { sessionId: 'B-real', runId: b.id, generation: runtimeB.generation }
      setSession(registry, b.id, 'C-real')
      check(parentContextFromOwner(captured, settings) === null, '复用成别的真实 SID（同 runId）→ null，不把 B 的派活贴给 C')

      check(parentContextFromOwner(null, settings) === null, 'null owner → null（默认路径不受影响）')
      check(registry.activeRunnerId === a.id, '全程 active 始终是 A')

      {
        const fakeAgents = new Map()
        const fakeRuntimes = new Map()
        let fakeActive = null
        const addFake = (id, sessionId, generation, cwd) => {
          const agent = mkAgent(sessionId, undefined)
          agent.state.cwd = cwd
          fakeAgents.set(id, agent)
          fakeRuntimes.set(id, { runId: id, generation, sessionId })
        }
        context.runners = {
          activeRunner: () => (fakeActive ? { id: fakeActive, cwd: fakeAgents.get(fakeActive)?.getState()?.cwd } : null),
          agentOf: (id) => fakeAgents.get(id) ?? null,
          runtimeOf: (id) => fakeRuntimes.get(id) ?? null,
          resolveExpectedRunner: (expected) => (expected.runId && fakeRuntimes.has(expected.runId) ? expected.runId : null),
          statuses: () => [...fakeRuntimes.values()]
        }
        addFake('rA', 'A-real', 5, 'C:/proj')
        addFake('rB', 'B-real', 6, 'C:/other')
        fakeActive = 'rA'

        const capA = context.captureDefaultParent()
        check(capA?.runId === 'rA' && capA?.generation === 5 && capA?.sessionId === 'A-real', '默认父在第一个 await 前同步捕获 active A 的身份')

        fakeActive = 'rB'
        await Promise.resolve()
        await Promise.resolve()
        const defCtx = context.parentContextFromCapture(capA, settings)
        check(defCtx.parentRunId === 'rA' && defCtx.parentSessionId === 'A-real' && defCtx.parentGeneration === 5, '双 await 期间切 active B：派活仍准确挂捕获的 A 的身份')
        check(fakeActive === 'rB', '默认捕获不改动 active（B 不变）')

        fakeRuntimes.set('rA', { runId: 'rA', generation: 6, sessionId: 'A-real' })
        let rejected = false
        try { context.parentContextFromCapture(capA, settings) } catch { rejected = true }
        check(rejected, 'A 换代后默认捕获安全拒绝（不落 B）')
        fakeRuntimes.set('rA', { runId: 'rA', generation: 5, sessionId: 'C-real' })
        rejected = false
        try { context.parentContextFromCapture(capA, settings) } catch { rejected = true }
        check(rejected, 'A 的真实 SID 变成 C 后安全拒绝')
        const replacedAgent = mkAgent('A-real', undefined)
        replacedAgent.state.cwd = 'C:/proj'
        fakeAgents.set('rA', replacedAgent)
        rejected = false
        try { context.parentContextFromCapture(capA, settings) } catch { rejected = true }
        check(rejected, 'A 实例被换掉后安全拒绝')

        addFake('rA', 'pending:rA', 5, 'C:/proj')
        fakeActive = 'rA'
        const capPending = context.captureDefaultParent()
        fakeRuntimes.set('rA', { runId: 'rA', generation: 5, sessionId: 'A-real' })
        fakeAgents.get('rA').state = { ...fakeAgents.get('rA').state, sessionId: 'A-real' }
        const migratedDefault = context.parentContextFromCapture(capPending, settings)
        check(migratedDefault.parentRunId === 'rA' && migratedDefault.parentSessionId === 'A-real', '同代 pending → 真实 SID 默认捕获可用')

        fakeActive = null
        const capNone = context.captureDefaultParent()
        check(capNone === null, '无 active 实例时捕获为 null（启动早期）')
        fakeActive = 'rA'
        const noneCtx = context.parentContextFromCapture(capNone, settings)
        check(noneCtx.parentRunId === undefined && noneCtx.cwd === settings.cwd, '启动早期不冒认后来出现的父（cwd-only 兼容）')

        fakeRuntimes.set('rA', { runId: 'rA', generation: 5, sessionId: 'A-real' })
        const explicitB = context.resolveSubagentParentContext(
          { sessionId: 'B-real', runId: 'rB', generation: 6 },
          capA,
          settings
        )
        check(explicitB.parentRunId === 'rB', '显式 owner 定位 B，不走默认 active A')
        rejected = false
        try { context.resolveSubagentParentContext(null, capA, settings) } catch { rejected = true }
        check(rejected, '显式 null owner 判为无效（不 fallback 默认 active）')
        rejected = false
        try { context.resolveSubagentParentContext({}, capA, settings) } catch { rejected = true }
        check(rejected, '瘦字段 owner 判为无效（不 fallback 默认 active）')
        rejected = false
        try { context.resolveSubagentParentContext({ runId: 'rA', generation: 0 }, capA, settings) } catch { rejected = true }
        check(rejected, '显式代次 0（非法）判为无效（不 fallback）')
        const capFresh = context.captureDefaultParent()
        const defaultCtx = context.resolveSubagentParentContext(undefined, capFresh, settings)
        check(defaultCtx.parentRunId === 'rA', '未传 owner 走默认捕获的 active A')
      }

      {
        const { SubagentController } = await loadBundle(
          fileURLToPath(new URL('../src/main/subagents.ts', import.meta.url)),
          dir,
          'subagents'
        )
        const emitted = []
        const controller = new SubagentController({ cwd: 'C:/proj', onChange: (run) => emitted.push(run) })
        const putRun = (id, over) => {
          controller.runs.set(id, {
            id, task: 't', cwd: 'C:/proj', isolation: 'shared-cwd', status: 'running',
            startedAt: 1, transcript: [], review: 'none',
            ...over
          })
          return controller.runs.get(id)
        }
        const adopt = (over) => controller.adoptParentSession({
          parentRunId: 'rA', parentGeneration: 5, fromSessionId: 'pending:rA', toSessionId: 'A-real', ...over
        })

        putRun('sub-ok', { parentRunId: 'rA', parentGeneration: 5, parentSessionId: 'pending:rA' })
        const changed = adopt({})
        check(changed.length === 1 && changed[0].parentSessionId === 'A-real', '真实控制器：同代 pending → 真实 SID 只迁移自己的 parentSID')
        check(emitted.length === 1 && emitted[0].parentSessionId === 'A-real', '迁移推一次 updated 快照')

        putRun('sub-nogen', { parentRunId: 'rA', parentSessionId: 'pending:rA' })
        check(adopt({}).length === 0 && controller.runs.get('sub-nogen').parentSessionId === 'pending:rA', '无 parentGeneration 的旧记录不猜')

        putRun('sub-wronggen', { parentRunId: 'rA', parentGeneration: 6, parentSessionId: 'pending:rA' })
        check(adopt({}).length === 0, '不同代次不收养')

        putRun('sub-stable', { parentRunId: 'rA', parentGeneration: 5, parentSessionId: 'A-real' })
        check(adopt({}).length === 0, 'stable 父（非 pending 占位）不被收养')

        putRun('sub-other', { parentRunId: 'rB', parentGeneration: 5, parentSessionId: 'pending:rB' })
        check(adopt({}).length === 0 && controller.runs.get('sub-other').parentSessionId === 'pending:rB', '别的 runId 不收养')

        putRun('sub-zero', { parentRunId: 'rA', parentGeneration: 0, parentSessionId: 'pending:rA' })
        check(adopt({ parentGeneration: 0 }).length === 1, 'parentGeneration 为 0 也是有效证明')

        putRun('sub-hook', { parentRunId: 'rA', parentGeneration: 5, parentSessionId: 'pending:rA' })
        const hookBefore = emitted.length
        context.runners = { statuses: () => [{ runId: 'rA', sessionId: 'A-real', generation: 5 }] }
        context.push = () => {}
        context.syncAppViewForeground = () => {}
        context.refreshTrayMenu = () => {}
        context.refreshTaskbar = () => {}
        context.syncKeepAwake = () => {}
        let noticeRetries = 0
        context.notifySubagentFinished = { retry: () => { noticeRetries += 1 } }
        context.subagentService = { current: () => controller }
        context.pushRunners()
        check(controller.runs.get('sub-hook').parentSessionId === 'A-real', '生产 pushRunners 钩子在真实 SID 落定时通知 producer 完成迁移')
        check(noticeRetries === 1, 'pushRunners 顺带重投未送达的子代理完成通知')
        check(emitted.length === hookBefore + 1 && emitted.at(-1).parentSessionId === 'A-real', '钩子只推一次 updated 快照')
        const indexSource = await fs.readFile(fileURLToPath(new URL('../src/main/index.ts', import.meta.url)), 'utf8')
        check(/if \(msg\.ch === 'state'\) pushRunners\(\)/.test(indexSource), '生产调用链：pushFrom 的 state 分支会通知 pushRunners（钩子可达）')

        putRun('sub-reuse', { parentRunId: 'rA', parentGeneration: 5, parentSessionId: 'pending:rA' })
        context.runners = { statuses: () => [{ runId: 'rA', sessionId: 'A-real', generation: 6 }] }
        context.pushRunners()
        check(controller.runs.get('sub-reuse').parentSessionId === 'pending:rA', '新代次/复用不收养旧 pending')

        const { selectSubagentRuns } = await loadBundle(
          fileURLToPath(new URL('../src/renderer/src/state/subagent-view.ts', import.meta.url)),
          dir,
          'subagent-view-select'
        )
        const migratedRun = controller.runs.get('sub-ok')
        const beforeGroups = selectSubagentRuns([{ ...migratedRun, parentSessionId: 'pending:rA' }], { sessionIds: ['A-real'] })
        check(beforeGroups.all.length === 0 && beforeGroups.foreign.length === 1, '迁移前 pending 父在真实 SID 视图里不可见（现状，不猜）')
        const afterGroups = selectSubagentRuns([migratedRun], { sessionIds: ['A-real'] })
        check(afterGroups.all.length === 1, '迁移后真实 SID 视图能看到这个 child')
      }

      {
        const { registerSubagentsIpc } = await loadBundle(
          fileURLToPath(new URL('../src/main/ipc/subagents-ipc.ts', import.meta.url)),
          dir,
          'subagents-ipc-capture'
        )
        const handlers = new Map()
        const ipc = { handle: (channel, fn) => handlers.set(channel, fn) }
        const order = []
        const starts = []
        const contexts = []
        const ctrl = {
          setContext(ctx) { contexts.push(ctx) },
          async start(task, model, mode) { starts.push({ task, mode }); return { ok: true, run: { id: 'sub-x' } } }
        }
        const localSettings = { cwd: 'C:/fallback', projects: [] }
        const fakeAgents = new Map()
        const fakeRuntimes = new Map()
        let fakeActive = 'rA'
        for (const [id, sid, gen, cwd] of [['rA', 'pending:rA', 5, 'C:/proj'], ['rB', 'B-real', 6, 'C:/other']]) {
          const agent = mkAgent(sid, undefined)
          agent.state.cwd = cwd
          fakeAgents.set(id, agent)
          fakeRuntimes.set(id, { runId: id, generation: gen, sessionId: sid })
        }
        context.runners = {
          activeRunner: () => { order.push('activeRunner'); return { id: fakeActive, cwd: fakeAgents.get(fakeActive)?.getState()?.cwd } },
          agentOf: (id) => fakeAgents.get(id) ?? null,
          runtimeOf: (id) => fakeRuntimes.get(id) ?? null,
          resolveExpectedRunner: (expected) => (expected.runId && fakeRuntimes.has(expected.runId) ? expected.runId : null),
          statuses: () => []
        }
        let phase = 0
        const settleReal = (generation) => {
          fakeRuntimes.set('rA', { runId: 'rA', generation, sessionId: 'A-real' })
          fakeAgents.get('rA').state = { ...fakeAgents.get('rA').state, sessionId: 'A-real' }
        }
        const service = {
          get: async () => {
            order.push('service.get')
            await new Promise((r) => setTimeout(r, 1))
            if (phase === 0) { fakeActive = 'rB'; settleReal(5) } else { settleReal(6) }
            return ctrl
          }
        }
        const parentContext = async (owner) => {
          order.push('parentContext')
          const captured = context.captureDefaultParent()
          await new Promise((r) => setTimeout(r, 10))
          return context.resolveSubagentParentContext(owner, captured, localSettings)
        }
        registerSubagentsIpc(ipc, { service, parentContext })
        const start = handlers.get('yan:subagents:start')

        const first = await start('task A', 'model', 'shared-cwd', undefined)
        check(first.ok === true, 'IPC 默认派活成功')
        check(order.indexOf('parentContext') < order.indexOf('service.get'), 'IPC 在 service.get 之前开始父捕获')
        check(contexts[0].parentRunId === 'rA' && contexts[0].parentSessionId === 'A-real', 'service.get 等待期切 active B：派活仍挂捕获的 A')
        check(fakeActive === 'rB', '捕获不改动 active')

        fakeActive = 'rA'
        phase = 1
        order.length = 0
        const second = await start('task A2', 'model', 'shared-cwd', undefined)
        check(second.ok === false && starts.length === 1, '等待期父换代：明确失败、零 spawn、不 fallback')

        phase = 2
        fakeActive = 'rA'
        const explicit = await start('task B', 'model', 'shared-cwd', { sessionId: 'B-real', runId: 'rB', generation: 6 })
        check(explicit.ok === true && contexts.at(-1).parentRunId === 'rB', '显式 owner 在 IPC 层定位 B（active 仍 A）')
        check(fakeActive === 'rA', '显式 owner 不改动 active')

        const nullRes = await start('task', 'model', 'shared-cwd', null)
        check(nullRes.ok === false && starts.length === 2, '显式 null owner 在 IPC 层判无效、零 spawn')
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url
if (invokedDirectly) {
  let passed = 0
  let failed = 0
  await runSubagentParentOwnershipTests((condition, label) => {
    if (condition) { passed++; console.log(`  ok  ${label}`) } else { failed++; console.log(`  ✗ ${label}`) }
  })
  console.log(failed ? `\n✗ 子代理派活父归属：失败 ${failed} 项` : `\n✓ 子代理派活父归属：${passed} 项通过`)
  if (failed) process.exitCode = 1
}
