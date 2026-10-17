import fs from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'

export async function runSnapshotIdentityTests(ok) {
  const indexFile = fileURLToPath(new URL('../src/main/index.ts', import.meta.url))
  const source = await fs.readFile(indexFile, 'utf8')
  const sf = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
  const extracted = ['pushFrom', 'pushRunnerSnapshot'].map((name) => {
    const node = sf.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === name)
    if (!node) throw new Error('Missing ' + name)
    return node.getText(sf)
  }).join('\n')
  const code = ts.transpileModule(extracted + '\nglobalThis.testPushRunnerSnapshot = pushRunnerSnapshot;', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText

  const runnersBundle = await build({
    entryPoints: [fileURLToPath(new URL('../src/main/runners.ts', import.meta.url))],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false
  })
  const { RunnerRegistry } = await import(
    `data:text/javascript;base64,${Buffer.from(runnersBundle.outputFiles[0].text).toString('base64')}`
  )
  const runState = await build({
    entryPoints: [fileURLToPath(new URL('../src/core/run-state.ts', import.meta.url))],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false
  })
  const { sameRuntimeEnvelope } = await import(
    `data:text/javascript;base64,${Buffer.from(runState.outputFiles[0].text).toString('base64')}`
  )

  const noop = () => {}
  const makeAgent = (opts) => {
    const agent = {
      state: {
        sessionId: opts.sessionId ?? 'session-A',
        sessionFile: opts.sessionFile ?? 'C:/fixture/A.jsonl',
        cwd: 'C:/fixture',
        isAgentRunning: false,
        isStreaming: false,
        isCompacting: false
      },
      getState() { return this.state },
      getPendingUiCount() { return 0 },
      hasRunningBash() { return false },
      getConn() { return { state: 'ready' } },
      setRunnerGeneration() {},
      async start() { return { ok: true } },
      async stop() {},
      async switchSession(file) {
        this.state = { ...this.state, sessionFile: file, sessionId: file.endsWith('B.jsonl') ? 'session-B' : this.state.sessionId }
        return { ok: true }
      },
      async newSession() { return { ok: true } },
      async getMessages() {
        opts.reached?.()
        await opts.gate
        opts.duringRead?.(this)
        return opts.messages ?? [{ id: 'A-short', role: 'user', text: 'old A message' }]
      },
      async refreshStats() { return opts.stats ?? null },
      async refreshTodos() { return null },
      queueSnapshot() { return { steering: [], followUp: [] } },
      async restoreQueueSnapshot() { return { ok: true } }
    }
    return agent
  }

  const runCase = async (opts) => {
    const frames = []
    let registryRef = null
    const context = {
      runners: null,
      handoffIdentities: new Map(),
      push: (msg) => frames.push(msg),
      refreshTrayMenu: noop,
      requestPiPackageActivationTick: noop,
      observeCompaction: async () => {},
      sessionWork: { observePush: noop },
      syncPendingIsolations: async () => {},
      pushRunners: noop,
      readHistoryWithArtifacts: async () => {
        if (opts.chainRead) await opts.chainRead(registryRef)
        return opts.chain ?? null
      },
      emptyGoal: () => ({}),
      sameRuntimeEnvelope
    }
    vm.createContext(context)
    vm.runInContext(code, context)

    let reached, release
    const begun = new Promise((resolve) => { reached = resolve })
    const gate = new Promise((resolve) => { release = resolve })
    const agentOpts = { ...opts, reached, gate: opts.noReadDelay ? Promise.resolve() : gate }
    const registry = new RunnerRegistry({
      limit: 2,
      createAgent: (_id, cwd) => {
        const agent = makeAgent(agentOpts)
        agent.state.cwd = cwd
        return agent
      }
    })
    context.runners = registry
    registryRef = registry
    const first = await registry.select({ cwd: 'C:/fixture', sessionFile: 'C:/fixture/A.jsonl' })
    const pending = context.testPushRunnerSnapshot(first.id, opts.chainHistory ? { chainHistory: true } : {})
    await begun
    if (opts.switchDuring) await opts.switchDuring(registry)
    release()
    await pending
    return { frames, registry, firstId: first.id }
  }

  {
    const { frames, registry, firstId } = await runCase({
      switchDuring: (reg) => reg.select({ cwd: 'C:/fixture', sessionFile: 'C:/fixture/B.jsonl' })
    })
    const syncs = frames.filter((f) => f.ch === 'sync')
    ok(syncs.length === 0, '换会话后旧 A 消息不贴新 B 封套（不推 sync）', JSON.stringify(syncs))
    ok(registry.runtimeOf(firstId)?.sessionId === 'session-B', '前置：实例确实复用到 B')
  }

  {
    const { frames } = await runCase({
      noReadDelay: true,
      chainHistory: true,
      chain: { messages: [{ id: 'A-chain', role: 'user', text: 'old A chain history', sourceFile: 'C:/fixture/A.jsonl' }] },
      chainRead: (reg) => reg.select({ cwd: 'C:/fixture', sessionFile: 'C:/fixture/B.jsonl' })
    })
    const syncs = frames.filter((f) => f.ch === 'sync')
    ok(syncs.length === 0, 'chainHistory 读盘期间换会话也不贴新封套', JSON.stringify(syncs))
  }

  {
    const { frames } = await runCase({
      sessionId: 'pending:r1',
      duringRead: (agent) => { agent.state = { ...agent.state, sessionId: 'session-real-1' } },
      messages: [{ id: 'A-pending', role: 'user', text: 'pending migrated' }]
    })
    ok(frames.some((f) => f.ch === 'sync'), 'pending→uuid 同代次迁移不拦 sync', JSON.stringify(frames.filter((f) => f.ch === 'sync')))
  }

  {
    const { frames } = await runCase({
      sessionId: 'session-A',
      duringRead: (agent) => { agent.state = { ...agent.state, sessionId: 'session-A2' } }
    })
    ok(frames.filter((f) => f.ch === 'sync').length === 0, '同代次两个真实 SID 不能当成同一身份（丢弃 sync）', JSON.stringify(frames.filter((f) => f.ch === 'sync')))
  }

  {
    const { frames } = await runCase({ sessionId: 'session-A' })
    const syncs = frames.filter((f) => f.ch === 'sync')
    ok(syncs.length === 1, '没有切换时 sync 正常推送且只推一次', JSON.stringify(syncs))
    ok(syncs[0].runtime?.sessionId === 'session-A', 'sync 贴的是采集时的封套', JSON.stringify(syncs[0].runtime))
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let passed = 0
  let failed = 0
  await runSnapshotIdentityTests((condition, label, detail) => {
    if (condition) passed++
    else {
      failed++
      console.error(`FAIL: ${label}`, detail ?? '')
    }
  })
  console.log(`Snapshot identity tests: ${passed} passed, ${failed} failed`)
  if (failed) process.exitCode = 1
}
