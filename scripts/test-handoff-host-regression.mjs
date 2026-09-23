import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'

// Execute the production host functions with controlled IO; importing index.ts would launch Electron.
export async function runHandoffHostRegressionTests(ok) {
  const source = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
  const functions = ['collectHandoffResult', 'revalidateHandoff']
  const extracted = ast.statements.filter((node) => ts.isFunctionDeclaration(node) && functions.includes(node.name?.text))
  if (extracted.length !== functions.length) throw new Error('Missing host functions for behavioral regressions')
  const code = ts.transpileModule(extracted.map((node) => node.getText(ast)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText
  const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
  const setup = () => {
    const pending = { request: { operationId: 'op', handoffId: 'handoff', sessionKey: 'source' }, goalId: 'goal' }
    const map = new Map([['run', pending]])
    const calls = { commits: 0, resumes: 0, lockHeld: false }
    const ctx = vm.createContext({
      handoffPending: map, clearInterval() {}, clearTimeout() {},
      ownsHandoffOperation: (a, b) => !b || a === b,
      handoffRequests: { readResult: async () => ({ operationId: 'op', handoffId: 'handoff', text: '{}' }), clearResult: async () => {}, clearRequest: async () => {} },
      handoffDiag: { record() {} }, handoffNotify() {},
      parseHandoffOutput: () => ({ ok: true, value: {} }), sanitizeHandoffPackage: () => ({}),
      handoffs: { setPackage: async () => {} }, handoffSummary: () => '', HANDOFF_COMMIT_ENABLED: true,
      commitHandoff: async () => { calls.commits++; calls.lockHeld = map.get('run') === pending },
      maybeArmGoalContinue: async () => { calls.resumes++ },
      goals: { load: async () => {}, isPaused: () => true, state: () => ({ phase: 'executing', goalId: 'goal' }) },
      runners: { agentOf: () => ({ getState: () => ({}), getMessages: async () => [] }) },
      workModeKeyFor: () => 'source', isActiveGoalPhase: () => true,
      resolveWorkMode: async () => ({ mode: 'autonomous' }), keepsGoalResumeOnModeChange: () => true
    })
    vm.runInContext(code, ctx)
    return { ctx, map, pending, calls }
  }
  {
    const h = setup()
    const result = await h.ctx.revalidateHandoff({ runnerId: 'run', operationId: 'op', sessionKey: 'source', goalId: 'goal', sourceHead: null })
    ok(!result.ok && result.reason === 'user-paused', '暂停目标在提交复核被拒绝')
  }
  {
    const h = setup(), read = deferred(), commit = deferred()
    h.ctx.handoffRequests.readResult = () => read.promise
    h.ctx.commitHandoff = async () => { h.calls.commits++; h.calls.lockHeld = h.map.has('run'); await commit.promise }
    const first = h.ctx.collectHandoffResult('run', 'op')
    ok(await h.ctx.collectHandoffResult('run', 'op') === false, '轮询与超时同时收集，只允许一个读结果的所有者')
    read.resolve({ operationId: 'op', handoffId: 'handoff', text: '{}' })
    for (let i = 0; i < 12 && !h.calls.commits; i++) await Promise.resolve()
    ok(h.calls.lockHeld && h.pending.collecting, '提交异步等待期间仍保留交接所有权')
    ok(await h.ctx.collectHandoffResult('run', 'op') === false, '提交期间的重复收集不能再次提交')
    commit.resolve(); await first
    ok(h.calls.commits === 1 && !h.map.size, '只提交一次并在结束后释放所有权')
  }
  for (const failure of ['provider', 'parse', 'incomplete', 'persist']) {
    const h = setup()
    if (failure === 'provider') h.ctx.handoffRequests.readResult = async () => ({ operationId: 'op', handoffId: 'handoff', error: 'failed' })
    if (failure === 'parse') h.ctx.parseHandoffOutput = () => ({ ok: false, reason: 'invalid' })
    if (failure === 'incomplete') h.ctx.sanitizeHandoffPackage = () => null
    if (failure === 'persist') h.ctx.handoffs.setPackage = async () => { throw new Error('disk unavailable') }
    await h.ctx.collectHandoffResult('run', 'op')
    ok(h.calls.commits === 0 && h.calls.resumes === 1 && !h.map.size, `${failure} 失败释放交接占用并恢复正常续行调度`)
  }
  {
    const h = setup(), read = deferred()
    h.ctx.handoffRequests.readResult = () => read.promise
    const collecting = h.ctx.collectHandoffResult('run', 'op')
    h.pending.cancelled = true
    read.resolve({ operationId: 'op', handoffId: 'handoff', text: '{}' })
    await collecting
    ok(!h.calls.commits && !h.calls.resumes && !h.map.size, '读结果期间用户停止，不提交也不恢复自动续跑')
  }
  let sendHandler
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.arguments[0]?.text === 'yan:send') sendHandler = node.arguments[1]
    ts.forEachChild(node, visit)
  }
  visit(ast)
  if (!sendHandler) throw new Error('Missing production send handler')
  const sendCode = ts.transpileModule(`const sendUser = ${sendHandler.getText(ast)}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText
  for (const selected of ['source', 'dest', 'stopped', 'cancelled']) {
    const gate = deferred(), sent = []
    const op = { collecting: true, settled: gate.promise, destinationRunId: 'dest' }
    const registry = { activeRunnerId: selected === 'cancelled' ? 'source' : selected, agentOf: (id) => ({ running: id !== 'stopped', send: async () => { sent.push(id); return { ok: true } } }) }
    const ctx = vm.createContext({
      handoffPending: new Map(selected === 'stopped' ? [] : [['source', op]]), runners: registry,
      goals: { load: async () => {}, state: () => ({}), resumeOf: () => null, isPaused: () => false, setPaused: async () => {}, resetAutoContinues: async () => {} },
      resolveWorkMode: async () => ({ mode: 'standard' }), workModeKeyFor: (id) => id,
      resetAutoContinue: async () => {},
      startAgent: async () => { registry.activeRunnerId = 'restarted'; return { ok: true } }
    })
    vm.runInContext(sendCode, ctx)
    const sending = vm.runInContext("sendUser('用户消息')", ctx)
    if (selected !== 'stopped') registry.activeRunnerId = 'unrelated-chat'
    if (selected === 'cancelled') op.cancelled = true
    gate.resolve()
    const result = await sending
    if (selected === 'cancelled') ok(!result.ok && sent.length === 0, '等待交接期间停止，保留输入而不发送')
    else ok(result.ok && sent.join() === (selected === 'stopped' ? 'restarted' : 'dest'), `${selected} 发送绑定正确实例，不受异步期间切会话影响`)
  }
}
