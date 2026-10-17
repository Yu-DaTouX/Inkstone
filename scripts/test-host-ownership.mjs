import fs from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'

export async function runHostOwnershipTests(ok) {
  const indexFile = fileURLToPath(new URL('../src/main/index.ts', import.meta.url))
  const source = await fs.readFile(indexFile, 'utf8')
  const sf = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
  const names = ['normalizeExpectedRuntime', 'targetMatchesExpected', 'resolveExpectedTarget', 'pinSendTarget', 'pinnedTargetMatches']
  const extracted = names.map((name) => {
    const node = sf.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === name)
    if (!node) throw new Error('Missing ' + name)
    return node.getText(sf)
  }).join('\n')
  const code = ts.transpileModule(extracted, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText

  let sendHandlerNode
  const findSendHandler = (node) => {
    if (ts.isCallExpression(node) && node.arguments[0]?.text === 'yan:send') sendHandlerNode = node.arguments[1]
    ts.forEachChild(node, findSendHandler)
  }
  findSendHandler(sf)
  if (!sendHandlerNode) throw new Error('Missing production yan:send handler')
  const sendCode = ts.transpileModule(`${extracted}\nconst sendUser = ${sendHandlerNode.getText(sf)}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
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

  const mkAgent = (sessionId, sessionFile) => ({
    state: { sessionId, sessionFile, isAgentRunning: false, isStreaming: false, isCompacting: false },
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
  })

  const registry = new RunnerRegistry({
    limit: 3,
    createAgent: (id, cwd, generation) => {
      const agent = mkAgent(`s-${id}`, undefined)
      agent.state.cwd = cwd
      if (generation !== undefined) agent.capabilityGeneration = generation
      return agent
    }
  })
  const context = { runners: registry, sameRuntimeEnvelope }
  vm.createContext(context)
  vm.runInContext(code, context)
  const { normalizeExpectedRuntime, targetMatchesExpected, resolveExpectedTarget } = context

  {
    ok(normalizeExpectedRuntime(undefined) === null, 'undefined → null（老调用）')
    ok(normalizeExpectedRuntime(null) === null, 'null → null（老调用）')
    const valid = normalizeExpectedRuntime({ runId: 'r1', generation: 2 })
    ok(valid && valid.runId === 'r1' && valid.generation === 2, '合法 runId + generation 通过', JSON.stringify(valid))
    ok(normalizeExpectedRuntime('r1') === 'invalid', '字符串不是合法结构')
    ok(normalizeExpectedRuntime({}) === 'invalid', '空对象不是合法结构')
    ok(normalizeExpectedRuntime({ runId: '' }) === 'invalid', '空 runId 非法')
    ok(normalizeExpectedRuntime({ generation: 0 }) === 'invalid', '0 代次非法')
    ok(normalizeExpectedRuntime({ generation: 1.5 }) === 'invalid', '非整数代次非法')
    ok(normalizeExpectedRuntime({ runId: 5 }) === 'invalid', '非字符串 runId 非法')
  }

  {
    const a = await registry.select({ cwd: 'C:/proj', sessionFile: 'C:/proj/A.jsonl' })
    registry.agentOf(a.id).state = { ...registry.agentOf(a.id).state, isAgentRunning: true }
    const b = await registry.select({ cwd: 'C:/other', sessionFile: 'C:/other/B.jsonl' })
    registry.agentOf(a.id).state = { ...registry.agentOf(a.id).state, isAgentRunning: false }
    ok(a.id !== b.id, '前置：A/B 是两个独立 runner', `${a.id} vs ${b.id}`)
    ok(registry.activeRunnerId === b.id, '前置：当前 active 是 B')
    const runtimeA = registry.runtimeOf(a.id)
    const resolved = resolveExpectedTarget({ runId: runtimeA.runId, generation: runtimeA.generation })
    ok(resolved === a.id, '即使 active 是 B，也能按 expectedRuntime 定向 A', `${resolved} vs ${a.id}`)
    ok(registry.activeRunnerId === b.id, '定向 A 不把 active 改成 A')
    ok(registry.agentOf(a.id)?.getState()?.sessionFile === 'C:/proj/A.jsonl', '定向不切 A 的 cwd / 会话')

    ok(resolveExpectedTarget({ runId: runtimeA.runId, generation: runtimeA.generation + 9 }) === null,
      'generation 不符时目标定位失败（不猜）')
    ok(resolveExpectedTarget({ runId: 'r-does-not-exist', generation: 1 }) === null, 'runId 不存在时定位失败')
  }

  {
    const a = await registry.select({ cwd: 'C:/sid', sessionFile: 'C:/sid/A.jsonl' })
    const real = registry.runtimeOf(a.id)
    agentSession(registry, a.id, 'real-session-A')
    ok(resolveExpectedTarget({ sessionId: 'real-session-A' }) === a.id, '按真实 sessionId 定位到实例')
    ok(resolveExpectedTarget({ sessionId: `pending:${a.id}` }) === a.id, 'pending:<runId> 退回 runId 定位')
    ok(resolveExpectedTarget({ sessionId: 'real-session-Z' }) === null, '不存在的真实 sessionId 定位失败')
    void real
  }

  {
    const a = await registry.select({ cwd: 'C:/match', sessionFile: 'C:/match/A.jsonl' })
    const gen = registry.runtimeOf(a.id).generation
    agentSession(registry, a.id, 'pending:x')
    ok(targetMatchesExpected(a.id, { sessionId: 'pending:x', generation: gen }) === true, 'pending 自身匹配')
    agentSession(registry, a.id, 'real-1')
    ok(targetMatchesExpected(a.id, { sessionId: 'pending:x', generation: gen }) === true, 'pending → 真实 uuid 同代次允许')
    ok(targetMatchesExpected(a.id, { sessionId: 'real-1', generation: gen }) === true, '真实 uuid 自身匹配')
    ok(targetMatchesExpected(a.id, { sessionId: 'real-2', generation: gen }) === false, '两个不同真实 SID 不能互换')
    agentSession(registry, a.id, 'pending:y')
    ok(targetMatchesExpected(a.id, { sessionId: 'real-1', generation: gen }) === false,
      '提交时是真实 SID、现在变 pending（换会话）不匹配')
    ok(targetMatchesExpected(a.id, { generation: gen + 1 }) === false, '代次不符不匹配')
  }

  const deferred = () => {
    let resolve
    const promise = new Promise((r) => { resolve = r })
    return { promise, resolve }
  }
  const mkSendAgent = (id, cwd, generation, sink) => ({
    state: { sessionId: `sess-${id}`, sessionFile: undefined, cwd, isAgentRunning: false, isStreaming: false, isCompacting: false },
    capabilityGeneration: generation,
    running: true,
    getState() { return this.state },
    getPendingUiCount() { return 0 },
    hasRunningBash() { return false },
    getConn() { return { state: 'ready' } },
    setRunnerGeneration(g) { this.capabilityGeneration = g },
    async start() { return { ok: true } },
    async stop() {},
    async switchSession(p) {
      const name = String(p).split(/[\\/]/).pop().replace(/\.jsonl$/, '')
      this.state = { ...this.state, sessionFile: p, sessionId: `sess-${name}` }
      return { ok: true }
    },
    async newSession() { this.state = { ...this.state, sessionFile: undefined, sessionId: 'sess-new' }; return { ok: true } },
    queueSnapshot() { return { steering: [], followUp: [] } },
    async restoreQueueSnapshot() { return { ok: true } },
    async send(text) { sink.push({ sessionId: this.state.sessionId, kind: 'send', text }); return { ok: true } },
    get workingDirectory() { return this.state.cwd }
  })
  const makeSendEnv = () => {
    const deliveries = []
    const checkpoints = []
    const gate = deferred()
    const registry = new RunnerRegistry({
      limit: 3,
      createAgent: (id, cwd, generation) => mkSendAgent(id, cwd, generation, deliveries)
    })
    const context = vm.createContext({
      runners: registry,
      startAgent: async () => ({ ok: true }),
      getSettings: () => gate.promise,
      captureCheckpoint: (...args) => { checkpoints.push(args) },
      sameRuntimeEnvelope
    })
    vm.runInContext(sendCode, context)
    return { ctx: context, registry, deliveries, checkpoints, gate, sendUser: vm.runInContext('sendUser', context) }
  }
  const seedSend = (registry, cwd = 'C:/proj', file = 'A.jsonl') =>
    registry.select({ cwd, sessionFile: `${cwd}/${file}` }).then((seed) => seed.runId)
  const reuseCrossCwd = (registry) => registry.select({ cwd: 'C:/other', sessionFile: 'C:/other/B.jsonl' })
  const reuseSameCwd = (registry) => registry.select({ cwd: 'C:/proj', sessionFile: 'C:/proj/B.jsonl' })
  const setIsAgentRunning = (registry, id, running) => {
    const agent = registry.agentOf(id)
    agent.state = { ...agent.state, isAgentRunning: running }
  }
  const seedDistinct = async (registry, cwd, file) => {
    const id = await seedSend(registry, cwd, file)
    setIsAgentRunning(registry, id, true)
    return id
  }

  {
    const env = makeSendEnv()
    const id = await seedSend(env.registry)
    const sending = env.sendUser('A-msg', undefined, undefined, { runId: id })
    env.gate.resolve({ checkpointsEnabled: true })
    const res = await sending
    ok(res.ok === true && env.deliveries.length === 1 && env.deliveries[0].sessionId === 'sess-A',
      '[handler] 未换身份时 runId-only 正常发给 A', JSON.stringify(env.deliveries))
    ok(env.checkpoints.length === 1 && env.checkpoints[0][1] === 'sess-A', '[handler] 未换身份仍为 A 生成检查点')
  }
  {
    const env = makeSendEnv()
    const id = await seedSend(env.registry)
    const runtime = env.registry.runtimeOf(id)
    const sending = env.sendUser('A-msg', undefined, undefined, { runId: id, generation: runtime.generation, sessionId: runtime.sessionId })
    env.gate.resolve({ checkpointsEnabled: true })
    const res = await sending
    ok(res.ok === true && env.deliveries.length === 1 && env.deliveries[0].sessionId === 'sess-A',
      '[handler] 未换身份时完整 tuple 正常发给 A', JSON.stringify(env.deliveries))
  }

  for (const [label, reuse] of [['同 cwd', reuseSameCwd], ['跨 cwd', reuseCrossCwd]]) {
    const env = makeSendEnv()
    const id = await seedSend(env.registry)
    const before = env.registry.runtimeOf(id)
    const sending = env.sendUser('A-msg', undefined, undefined, { runId: id })
    const reused = await reuse(env.registry)
    env.gate.resolve({ checkpointsEnabled: true })
    const res = await sending
    const after = env.registry.runtimeOf(id)
    ok(reused.via === 'reuse' && after.generation !== before.generation,
      `[handler] ${label}复用前置：同 runId 换了代次`, JSON.stringify({ before, after, via: reused.via }))
    ok(res.ok === false && env.deliveries.length === 0,
      `[handler] runId-only + ${label}复用 → 零派发（拒绝）`, JSON.stringify({ res, deliveries: env.deliveries }))
    ok(env.checkpoints.length === 0, `[handler] runId-only + ${label}复用 → 零检查点副作用`)
  }

  for (const [label, reuse] of [['同 cwd', reuseSameCwd], ['跨 cwd', reuseCrossCwd]]) {
    const env = makeSendEnv()
    await seedSend(env.registry)
    const sending = env.sendUser('A-msg', undefined, undefined, undefined)
    await reuse(env.registry)
    env.gate.resolve({ checkpointsEnabled: true })
    const res = await sending
    ok(res.ok === false && env.deliveries.length === 0,
      `[handler] 缺省 expected + ${label}复用 → 零派发`, JSON.stringify({ res, deliveries: env.deliveries }))
    ok(env.checkpoints.length === 0, `[handler] 缺省 expected + ${label}复用 → 零检查点副作用`)
  }
  for (const [label, reuse] of [['同 cwd', reuseSameCwd], ['跨 cwd', reuseCrossCwd]]) {
    const env = makeSendEnv()
    const id = await seedSend(env.registry)
    const sending = env.sendUser('A-msg', undefined, undefined, { sessionId: `pending:${id}` })
    await reuse(env.registry)
    env.gate.resolve({ checkpointsEnabled: true })
    const res = await sending
    ok(res.ok === false && env.deliveries.length === 0,
      `[handler] pending-only + ${label}复用 → 零派发`, JSON.stringify({ res, deliveries: env.deliveries }))
    ok(env.checkpoints.length === 0, `[handler] pending-only + ${label}复用 → 零检查点副作用`)
  }

  {
    const env = makeSendEnv()
    const id = await seedSend(env.registry)
    const runtime = env.registry.runtimeOf(id)
    const sending = env.sendUser('A-msg', undefined, undefined, { runId: id, generation: runtime.generation, sessionId: runtime.sessionId })
    await reuseCrossCwd(env.registry)
    env.gate.resolve({ checkpointsEnabled: true })
    const res = await sending
    ok(res.ok === false && env.deliveries.length === 0,
      '[handler] 完整 tuple + 复用 → 零派发（负对照保持）', JSON.stringify({ res, deliveries: env.deliveries }))
  }

  {
    const deliveries = []
    const registry = new RunnerRegistry({ limit: 3, createAgent: (id, cwd, generation) => mkSendAgent(id, cwd, generation, deliveries) })
    const context = vm.createContext({
      runners: registry,
      startAgent: async () => ({ ok: true }),
      getSettings: () => Promise.resolve({ checkpointsEnabled: true }),
      captureCheckpoint: () => {},
      sameRuntimeEnvelope
    })
    vm.runInContext(sendCode, context)
    const sendUser = vm.runInContext('sendUser', context)
    const id = await seedSend(registry)
    const sending = sendUser('A-msg', undefined, undefined, { runId: id })
    await registry.select({ cwd: 'C:/other', sessionFile: 'C:/other/B.jsonl' })
    const res = await sending
    ok(res.ok === true && deliveries.length === 1 && deliveries[0].sessionId === 'sess-A',
      '[handler] settings 缓存命中（微任务）时仍发给 A', JSON.stringify(deliveries))
  }
}

function agentSession(registry, id, sessionId) {
  const agent = registry.agentOf(id)
  agent.state = { ...agent.state, sessionId }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let passed = 0
  let failed = 0
  await runHostOwnershipTests((condition, label, detail) => {
    if (condition) passed++
    else {
      failed++
      console.error(`FAIL: ${label}`, detail ?? '')
    }
  })
  console.log(`Host ownership tests: ${passed} passed, ${failed} failed`)
  if (failed) process.exitCode = 1
}
