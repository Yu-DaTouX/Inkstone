import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'
import { build } from 'esbuild'

const work = await mkdtemp(join(tmpdir(), 'inkstone-move-continuation-'))
let checks = 0
const ok = (value, label) => { assert.ok(value, label); checks++ }
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const tick = () => new Promise(r => setImmediate(r))
const functionTexts = (source, names) => {
  const ast = ts.createSourceFile('fixture.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const result = []
  const visit = node => {
    if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) {
      const text = node.getText(ast)
      result.push(text.startsWith('export ') ? text.slice(7) : text)
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.equal(result.length, names.length)
  return result.join('\n')
}
const transpile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
try {
  const output = join(work, 'move.mjs')
  await build({ entryPoints: ['src/main/session-move.ts'], outfile: output, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const { captureMoveContinuation, movedSessionContinuationPrompt, rewriteSessionCwd } = await import(pathToFileURL(output).href)
  const agentSource = await readFile('src/main/agent.ts', 'utf8')
  const agentAst = ts.createSourceFile('agent.ts', agentSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const methods = []
  const collect = node => { if ((ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node)) && ['captureSessionMoveContinuation', 'getState', 'getPendingUiCount', 'running'].includes(node.name?.getText(agentAst))) methods.push(node.getText(agentAst)); ts.forEachChild(node, collect) }
  collect(agentAst)
  assert.equal(methods.length, 4)
  const probeContext = { captureMoveContinuation }
  vm.runInNewContext(transpile('globalThis.Probe = class { ' + methods.join('\n') + ' }'), probeContext)
  const agent = (sessionId, sessionFile, cwd, generation) => Object.assign(new probeContext.Probe(), {
    state: { sessionId, sessionFile, cwd, isAgentRunning: false, isStreaming: false, isCompacting: false },
    capabilityOpts: { runnerGeneration: generation }, loopGuardContinuationVersion: 0, sessionMoveFailureVersion: 0,
    rpc: { running: true }, conn: 'ready', stopping: false, agentRunning: false, streaming: null, bash: null,
    ui: { pending: new Map() }, queueState: { steering: [], followUp: [] }
  })
  const original = agent('sid', '/saved.jsonl', work, 1)
  const guard = original.captureSessionMoveContinuation()
  ok(guard(), 'normal idle origin eligible')
  original.agentRunning = true; ok(!guard(), 'active origin cannot continue yet'); original.agentRunning = false
  original.loopGuardContinuationVersion++; ok(!guard(), 'manual stop or new input invalidates'); original.loopGuardContinuationVersion--
  original.sessionMoveFailureVersion++; ok(!guard(), 'model failure invalidates after timing reset'); original.sessionMoveFailureVersion--
  original.capabilityOpts.runnerGeneration++; ok(!guard(), 'generation change invalidates'); original.capabilityOpts.runnerGeneration--
  original.state.sessionId = 'other'; ok(!guard(), 'session reuse invalidates'); original.state.sessionId = 'sid'
  original.ui.pending.set('question', {}); ok(!guard(), 'pending human input blocks'); original.ui.pending.clear()
  original.queueState.followUp.push('queued'); ok(!guard(), 'pending follow-up blocks'); original.queueState.followUp = []
  original.stopping = true; original.rpc = null; original.loopGuardContinuationVersion++
  ok(guard(true), 'exactly one host close allowed')
  original.loopGuardContinuationVersion++; ok(!guard(true), 'additional stop after close cancels')

  const main = await readFile('src/main/index.ts', 'utf8')
  const hostFunctions = functionTexts(main, ['requestSessionMove', 'moveSessionWhenIdle', 'continueMovedSession', 'pinSendTarget', 'pinnedTargetMatches', 'normalizeCwdForIdentity'])
  const { sameRuntimeEnvelope } = await (async () => { const file = join(work, 'identity.mjs'); await build({ entryPoints: ['src/core/run-state.ts'], outfile: file, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' }); return import(pathToFileURL(file).href) })()
  const hostCode = transpile('const pendingSessionMoves = new Map(); globalThis.pending = pendingSessionMoves;\n' + hostFunctions)
  const target = join(work, 'target')
  const file = join(work, 'source.jsonl')
  const fixture = (hooks = {}) => {
    const events = [], sent = [], moved = [], errors = []
    const origin = agent('sid', file, work, 1)
    const agents = new Map([['origin', origin]])
    let context
    let wall = 1000
    const registry = {
      activeId: 'unrelated-foreground',
      statuses: () => [...agents].map(([id, a]) => ({ id, runId: id, generation: a.capabilityOpts.runnerGeneration, sessionId: a.state.sessionId, sessionFile: a.state.sessionFile })),
      runtimeOf: id => { const a = agents.get(id); return a ? { runId: id, generation: a.capabilityOpts.runnerGeneration, sessionId: a.state.sessionId } : null },
      agentOf: id => agents.get(id),
      async stopOne(id) {
        assert.equal(id, 'origin')
        if (hooks.closeFails) return false
        origin.loopGuardContinuationVersion++; origin.stopping = true; origin.rpc = null; origin.conn = 'exited'
        agents.delete(id)
        await hooks.close?.(context)
        return true
      },
      async select(request) {
        if (hooks.selectFails) return { ok: false, error: 'fixture select failure' }
        assert.equal(request.activate, false)
        const fresh = agent('sid', file, request.cwd, 2)
        fresh.send = async text => { sent.push({ sessionId: fresh.state.sessionId, cwd: fresh.state.cwd, text }); fresh.loopGuardContinuationVersion++; return hooks.sendFails ? { ok: false, error: 'fixture send failure' } : { ok: true } }
        agents.set('restored', fresh)
        await hooks.select?.(context, fresh)
        return { ok: true, id: 'restored', runId: 'restored', generation: 2, sessionId: 'sid' }
      },
      guardExecute: () => hooks.busy ? { ok: false, error: 'fixture busy' } : { ok: true }
    }
    context = { runners: registry, shuttingDown: false, sameRuntimeEnvelope, movedSessionContinuationPrompt, resolve, isAbsolute,
      validateCwd: async cwd => hooks.invalidCwd ? ({ ok: false, error: 'fixture invalid cwd' }) : ({ ok: true, cwd }),
      approvals: { ask: async () => { await hooks.approval?.(context, origin); return hooks.choice ?? 'once' } },
      getSettings: async () => ({ projects: [{ id: 'project', cwd: target }], recentCwds: [] }),
      patchSettings: async () => { throw new Error('unexpected project creation') },
      rewriteSessionCwd: async (...args) => { if (hooks.rewriteFails) throw new Error('fixture write failure'); moved.push(args); await hooks.rewrite?.(context) },
      moveSessionLayout: async () => {}, push: event => events.push(event), pushRunners() {},
      reportMainError: (...args) => errors.push(args), Date: { now: () => wall },
      setTimeout: callback => setImmediate(() => {
        if (hooks.timeout) wall += 31 * 60_000
        if (hooks.endRun) { origin.state.isAgentRunning = false; origin.agentRunning = false }
        callback()
      }),
      sessionHost: { rememberRunnerSession: async () => { await hooks.remember?.(context, agents.get('restored')) }, pushRunnerSnapshot() {} }
    }
    vm.runInNewContext(hostCode, context)
    const request = (params = {}) => context.requestSessionMove({ sessionId: 'sid', sessionFile: file, cwd: work, dir: target, reason: 'fixture', ...params })
    const finish = async () => { for (let i = 0; i < 100 && !events.length; i++) await tick(); assert.equal(events.length, 1); return events[0].payload }
    return { context, origin, agents, registry, events, sent, moved, errors, request, finish }
  }
  let f = fixture()
  ok((await f.request()).decision === 'approved', 'approval returns without requiring user continue')
  const success = await f.finish()
  ok(success.ok && success.continued && f.sent.length === 1, 'successful move sends exactly one host continuation')
  ok(f.sent[0].sessionId === 'sid' && f.sent[0].cwd === target, 'continuation uses original SID in approved directory')
  ok(f.sent[0].text.startsWith('[砚宿主通知') && f.sent[0].text.includes('不要重放'), 'host message does not replay original request')
  ok(f.registry.activeId === 'unrelated-foreground', 'background resume does not steal foreground')
  f = fixture({ endRun: true, approval: (_, a) => { a.state.isAgentRunning = true; a.agentRunning = true } })
  await f.request()
  ok((await f.finish()).continued && f.sent.length === 1, 'host waits for normal round completion before resume')
  f = fixture()
  ok((await f.request({ dir: work })).decision === 'same' && !f.events.length, 'same directory needs no continuation')
  f = fixture({ invalidCwd: true })
  ok((await f.request()).decision === 'invalid' && !f.moved.length, 'invalid directory cannot move or resume')
  for (const [name, hooks, moved] of [
    ['denied', { choice: 'deny' }, 0],
    ['no answer', { choice: 'timeout' }, 0]
  ]) {
    f = fixture(hooks); await f.request(); await tick()
    ok(f.moved.length === moved && f.sent.length === 0 && f.events.length === 0, name + ' does not move or continue')
  }
  for (const [name, hooks, didMove] of [
    ['manual stop', { approval: (_, a) => { a.loopGuardContinuationVersion++ } }, true],
    ['model failure', { approval: (_, a) => { a.sessionMoveFailureVersion++ } }, true],
    ['close failure', { closeFails: true }, false],
    ['wait timeout', { timeout: true, approval: (_, a) => { a.state.isAgentRunning = true; a.agentRunning = true } }, false],
    ['write failure', { rewriteFails: true }, false],
    ['select failure', { selectFails: true }, true],
    ['runtime reuse', { remember: (_, a) => { a.capabilityOpts.runnerGeneration++ } }, true],
    ['registry replacement', { rewrite: context => { context.runners = {} } }, true],
    ['stale restored SID', { select: (_, a) => { a.state.sessionId = 'other' } }, true],
    ['stop during restore', { remember: (_, a) => { a.loopGuardContinuationVersion++ } }, true],
    ['pending follow-up', { select: (_, a) => { a.queueState.followUp.push('new input') } }, true],
    ['busy target cwd', { busy: true }, true],
    ['shutdown', { approval: context => { context.shuttingDown = true } }, false]
  ]) {
    f = fixture(hooks); await f.request(); const result = await f.finish()
    ok(f.sent.length === 0 && result.continued !== true, name + ' never auto-sends')
    ok(result.ok === didMove, name + ' reports move separately from continuation')
  }
  f = fixture({ approval: (_, a) => { a.state.sessionId = 'other' } })
  ok((await f.request()).decision === 'invalid' && f.moved.length === 0, 'changed approval origin is rejected')
  const approval = defer()
  f = fixture({ approval: () => approval.promise })
  const first = f.request()
  await tick()
  ok((await f.request()).decision === 'invalid', 'duplicate request rejected while approval pending')
  const job = [...f.context.pending.values()][0]
  approval.resolve(); await first; await f.finish()
  await f.context.moveSessionWhenIdle(job)
  ok(f.sent.length === 1 && f.events.length === 1, 'duplicate job notification cannot replay continuation')
  f = fixture({ sendFails: true }); await f.request()
  const rejected = await f.finish()
  ok(rejected.ok && !rejected.continued && rejected.continuationError.includes('send failure'), 'send rejection reports failure without retry')

  await mkdir(target)
  const tail = '\n{"type":"message","id":"keep","message":{"role":"user","content":"unchanged"}}\n'
  await writeFile(file, JSON.stringify({ type: 'session', version: 3, id: 'sid', cwd: work }) + tail)
  await rewriteSessionCwd(file, target)
  const rewritten = await readFile(file, 'utf8')
  ok(JSON.parse(rewritten.split('\n')[0]).cwd === target && rewritten.endsWith(tail), 'actual rewrite preserves complete history body')

  const pushSource = await readFile('src/renderer/src/state/push-consumers.ts', 'utf8')
  const pushCode = transpile(functionTexts(pushSource, ['consumeShellPush']))
  const renderer = {}; vm.runInNewContext(pushCode, renderer)
  const refresh = defer(); const switched = []; const state = { notices: [], session: { sessionId: 'sid' }, refreshSessions: () => refresh.promise, switchSession: path => switched.push(path) }
  let current = state
  const zhCatalog = JSON.parse(await readFile('src/renderer/src/i18n/zh-CN.json', 'utf8'))
  const translateZh = (key, vars) => {
    let text = zhCatalog[key] ?? key
    if (vars) for (const [name, value] of Object.entries(vars)) text = text.split('{' + name + '}').join(String(value))
    return text
  }
  const ctx = { get: () => current, set: patch => Object.assign(current, patch), pushNotice: (list, type, text) => [...list, { type, text }], t: translateZh }
  renderer.consumeShellPush({ ch: 'session-moved', payload: { sessionId: 'sid', sessionFile: file, cwd: target, ok: true, continued: true } }, state, ctx)
  current = { ...state, session: { sessionId: 'elsewhere' } }; refresh.resolve(); await tick()
  ok(switched.length === 0, 'renderer refresh cannot steal view after user navigates away')
  ok(state.notices[0].text.includes('正在继续'), 'renderer reports host continuation rather than issuing it')
  console.log(`Session move continuation: ${checks} passed`)
} finally {
  await rm(work, { recursive: true, force: true })
}
