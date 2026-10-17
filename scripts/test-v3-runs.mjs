import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

async function compile(entry, outfile, platform) {
  await build({ entryPoints: [entry], outfile, bundle: true, platform, format: 'esm', logLevel: 'silent' })
  return import(pathToFileURL(outfile).href)
}

function fakeTimers() {
  const tasks = []
  const set = (fn, ms) => {
    const handle = { fn, ms, cancelled: false }
    tasks.push(handle)
    return handle
  }
  const clear = (handle) => {
    if (handle) handle.cancelled = true
  }
  const pending = () => tasks.filter((t) => !t.cancelled)
  const runDue = () => {
    for (const task of pending()) {
      task.cancelled = true
      task.fn()
    }
  }
  return { set, clear, pending, runDue }
}

export async function runV3RunsTests() {
  const dir = await mkdtemp(join(tmpdir(), 'inkstone-v3-runs-'))
  try {
    const shared = await compile('src/shared/runs.ts', join(dir, 'shared.mjs'), 'neutral')
    const main = await compile('src/main/runs/index.ts', join(dir, 'main.mjs'), 'node')

    runSharedReducerTests(shared)
    runSignalMappingTests(main)
    await runRegistryTests(main, shared, dir)
    runPublisherTests(main, shared)
    await runSessionCodeTests(main, dir)
    await runHistoryTests(main, dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function baseState(shared, now = 1000) {
  return shared.createRunState({ runId: 'r1', code: 'S1', kind: 'session', sessionId: 's1', title: '标题' }, now)
}

function runSharedReducerTests(shared) {
  const { reduceRun, detectStall, DEFAULT_STALL_THRESHOLDS, isTerminalPhase, normalizeThresholds } = shared

  let s = baseState(shared, 1000)
  s = reduceRun(s, { type: 'queued', reason: 'concurrency' }, 1000)
  assert.equal(s.phase.kind, 'queued')
  assert.equal(s.phase.reason, 'concurrency')
  const queuedSince = s.phase.since
  s = reduceRun(s, { type: 'agent-start' }, 1100)
  assert.equal(s.phase.kind, 'running')
  assert.equal(s.phase.activity, 'waiting-model')
  assert.equal(queuedSince, 1000)

  s = reduceRun(s, { type: 'activity', activity: 'thinking' }, 1200)
  assert.equal(s.phase.activity, 'thinking')
  s = reduceRun(s, { type: 'activity', activity: 'streaming' }, 1300)
  assert.equal(s.phase.activity, 'streaming')
  assert.equal(s.lastEventAt, 1300)

  s = reduceRun(s, { type: 'tool-start', tool: { name: 'edit', label: 'src/a.ts', callId: 'c1' }, isWrite: true }, 1400)
  assert.equal(s.phase.activity, 'tool')
  assert.equal(s.phase.tool.name, 'edit')
  assert.equal(s.phase.tool.label, 'src/a.ts')
  assert.equal(s.counts.tools, 1)
  s = reduceRun(s, { type: 'tool-update' }, 1500)
  assert.equal(s.phase.activity, 'tool')
  assert.equal(s.lastEventAt, 1500)
  s = reduceRun(s, { type: 'tool-end', callId: 'c1', isWrite: true }, 1600)
  assert.equal(s.phase.activity, 'waiting-model')
  assert.equal(s.counts.edits, 1)
  s = reduceRun(s, { type: 'tool-start', tool: { name: 'bash', callId: 'c2' } }, 1700)
  s = reduceRun(s, { type: 'tool-end', callId: 'c2', isError: true }, 1800)
  assert.equal(s.counts.tools, 2)
  assert.equal(s.counts.errors, 1)

  s = reduceRun(s, { type: 'compaction-start' }, 1900)
  assert.equal(s.phase.activity, 'compacting')
  s = reduceRun(s, { type: 'compaction-end' }, 2000)
  assert.equal(s.phase.activity, 'waiting-model')

  s = reduceRun(s, { type: 'retry-start', attempt: 2, max: 3, resumeAt: 9000 }, 2100)
  assert.equal(s.phase.kind, 'stalled')
  assert.equal(s.phase.cause, 'retry')
  assert.deepEqual(s.phase.retry, { attempt: 2, max: 3, resumeAt: 9000 })
  s = reduceRun(s, { type: 'retry-end', success: true }, 2200)
  assert.equal(s.phase.kind, 'running')

  s = reduceRun(s, { type: 'retry-start', attempt: 1, max: 1 }, 2300)
  s = reduceRun(s, { type: 'retry-end', success: false, errorKind: 'auth', message: '认证失败' }, 2400)
  assert.equal(s.phase.kind, 'failed')
  assert.equal(s.phase.cause, 'model-error')
  assert.equal(s.phase.errorKind, 'auth')

  let still = baseState(shared, 1000)
  still = reduceRun(still, { type: 'agent-end', willRetry: true }, 1100)
  assert.equal(still.phase.kind, 'running')

  let err = baseState(shared, 1000)
  err = reduceRun(err, { type: 'error-observed', message: 'boom', errorKind: 'request' }, 1100)
  assert.equal(err.phase.kind, 'running')
  err = reduceRun(err, { type: 'agent-end', willRetry: false }, 1200)
  err = reduceRun(err, { type: 'agent-settled', aborted: false }, 1300)
  assert.equal(err.phase.kind, 'failed')
  assert.equal(err.phase.cause, 'model-error')

  let retried = baseState(shared, 1000)
  retried = reduceRun(retried, { type: 'error-observed', message: 'transient', errorKind: 'retryable' }, 1100)
  retried = reduceRun(retried, { type: 'retry-start', attempt: 1, max: 3 }, 1200)
  retried = reduceRun(retried, { type: 'retry-end', success: true }, 1300)
  retried = reduceRun(retried, { type: 'agent-settled', aborted: false }, 1400)
  assert.equal(retried.phase.kind, 'done')
  assert.equal(retried.pendingError, undefined)

  let userStop = baseState(shared, 1000)
  userStop = reduceRun(userStop, { type: 'agent-settled', aborted: true }, 1100)
  assert.equal(userStop.phase.kind, 'stopped')
  assert.equal(userStop.phase.by, 'user')

  let loop = baseState(shared, 1000)
  loop = reduceRun(loop, { type: 'loop-abort', detail: '重复输出' }, 1100)
  assert.equal(loop.phase.kind, 'stalled')
  assert.equal(loop.phase.cause, 'loop')
  assert.equal(loop.loopAbortMarked, true)
  loop = reduceRun(loop, { type: 'agent-settled', aborted: true }, 1200)
  assert.equal(loop.phase.kind, 'stalled')
  assert.equal(loop.phase.cause, 'loop')

  let quota = baseState(shared, 1000)
  quota = reduceRun(quota, { type: 'rate-limit', detail: '额度或限流', retry: { attempt: 1, max: 5, resumeAt: 60000 } }, 1100)
  assert.equal(quota.phase.kind, 'stalled')
  assert.equal(quota.phase.cause, 'rate-limit')

  let wait = baseState(shared, 1000)
  wait = reduceRun(wait, { type: 'needs-you', request: { id: 'q1', type: 'danger', summary: '删库' } }, 1100)
  assert.equal(wait.phase.kind, 'needs-you')
  assert.equal(wait.phase.request.id, 'q1')
  const waitSince = wait.phase.since
  wait = reduceRun(wait, { type: 'needs-you', request: { id: 'q2', type: 'select', summary: '选一个' } }, 1200)
  assert.equal(wait.requests.length, 2)
  assert.equal(wait.phase.request.id, 'q1')
  assert.equal(wait.phase.since, waitSince, '等待起点取最早的那个请求')
  wait = reduceRun(wait, { type: 'request-answered', requestId: 'q1' }, 1300)
  assert.equal(wait.phase.kind, 'needs-you')
  assert.equal(wait.phase.request.id, 'q2')
  wait = reduceRun(wait, { type: 'request-answered', requestId: 'q2' }, 1400)
  assert.equal(wait.phase.kind, 'running')
  assert.deepEqual(wait.requests, [], '最后一个请求答复后必须清空内部请求列表')
  wait = reduceRun(wait, { type: 'needs-you', request: { id: 'q3', type: 'confirm', summary: '下一次确认' } }, 1500)
  assert.equal(wait.phase.request.id, 'q3', '下一次确认不能展示已答复的旧请求')
  wait = reduceRun(wait, { type: 'request-answered', requestId: 'q3' }, 1600)
  assert.equal(wait.phase.kind, 'running')
  assert.deepEqual(wait.requests, [])

  let waitRetry = baseState(shared, 1000)
  waitRetry = reduceRun(waitRetry, { type: 'retry-start', attempt: 1, max: 3 }, 1100)
  waitRetry = reduceRun(waitRetry, { type: 'needs-you', request: { id: 'q1', type: 'confirm', summary: '继续?' } }, 1200)
  waitRetry = reduceRun(waitRetry, { type: 'request-answered', requestId: 'q1' }, 1300)
  assert.equal(waitRetry.phase.kind, 'stalled')
  assert.equal(waitRetry.phase.cause, 'retry')
  assert.deepEqual(waitRetry.requests, [], '返回重试状态时也必须清空已答复请求')

  let exit = baseState(shared, 1000)
  exit = reduceRun(exit, { type: 'pi-exit', code: 1 }, 1100)
  assert.equal(exit.phase.kind, 'failed')
  assert.equal(exit.phase.cause, 'pi-exit')

  let fatal = reduceRun(baseState(shared, 1000), { type: 'tool-fatal', message: '工具崩溃' }, 1100)
  assert.equal(fatal.phase.cause, 'tool-fatal')
  let hostFail = reduceRun(baseState(shared, 1000), { type: 'host-fail', message: '宿主失败' }, 1100)
  assert.equal(hostFail.phase.cause, 'host')

  let meta = baseState(shared, 1000)
  meta = reduceRun(meta, { type: 'context', used: 2500, window: 10000 }, 1100)
  assert.deepEqual(meta.context, { used: 2500, window: 10000, percent: 25 })
  meta = reduceRun(meta, { type: 'title', title: '新标题' }, 1200)
  assert.equal(meta.title, '新标题')
  meta = reduceRun(meta, { type: 'model', model: { provider: 'p', id: 'm', label: 'M' } }, 1300)
  assert.equal(meta.model.id, 'm')
  meta = reduceRun(meta, { type: 'cost', usd: 0.5 }, 1400)
  assert.equal(meta.costUsd, 0.5)

  const done = reduceRun(baseState(shared, 1000), { type: 'agent-settled', aborted: false }, 1100)
  assert.ok(isTerminalPhase(done.phase))
  assert.equal(reduceRun(done, { type: 'tool-start', tool: { name: 'edit', callId: 'c9' } }, 1200), done)
  const seen = reduceRun(done, { type: 'seen' }, 1300)
  assert.equal(seen.phase.seen, true)

  const running = baseState(shared, 1000)
  assert.equal(detectStall(running, 1000 + DEFAULT_STALL_THRESHOLDS.noOutputMs - 1), null)
  assert.equal(detectStall(running, 1000 + DEFAULT_STALL_THRESHOLDS.noOutputMs + 1), 'no-output')
  const inTool = reduceRun(running, { type: 'tool-start', tool: { name: 'bash', label: 'npm run build', callId: 'c1' } }, 1000)
  assert.equal(detectStall(inTool, 1000 + DEFAULT_STALL_THRESHOLDS.noOutputMs + 1), null, '工具执行中不按等待模型判定')
  assert.equal(detectStall(inTool, 1000 + DEFAULT_STALL_THRESHOLDS.toolSilentMs + 1), 'tool-silent')
  assert.equal(detectStall(inTool, 1000 + DEFAULT_STALL_THRESHOLDS.toolSilentMs + 1, DEFAULT_STALL_THRESHOLDS, { exemptTools: ['npm'] }), null)

  let parallel = reduceRun(running, { type: 'tool-start', tool: { name: 'bash', label: 'git status', callId: 'p1' } }, 1000)
  parallel = reduceRun(parallel, { type: 'tool-start', tool: { name: 'bash', label: 'grep -ril opencode', callId: 'p2' } }, 1000)
  parallel = reduceRun(parallel, { type: 'tool-end', callId: 'p1' }, 1100)
  assert.equal(parallel.phase.activity, 'tool', '并行工具未全部结束时仍算工具执行中')
  assert.equal(parallel.phase.tool.callId, 'p2')
  assert.equal(detectStall(parallel, 1100 + DEFAULT_STALL_THRESHOLDS.noOutputMs + 1), null, '剩余工具运行中不能误报无响应')
  assert.equal(detectStall(parallel, 1100 + DEFAULT_STALL_THRESHOLDS.toolSilentMs + 1, DEFAULT_STALL_THRESHOLDS, { exemptTools: ['git'] }), 'tool-silent')
  parallel = reduceRun(parallel, { type: 'stall-detected', cause: 'tool-silent' }, 70_000)
  assert.equal(parallel.phase.kind, 'stalled')
  parallel = reduceRun(parallel, { type: 'tool-end', callId: 'p2' }, 120_000)
  assert.equal(parallel.phase.kind, 'running')
  assert.equal(parallel.phase.activity, 'waiting-model')
  assert.deepEqual(parallel.activeTools, [])

  let waitTool = reduceRun(running, { type: 'tool-start', tool: { name: 'bash', callId: 'w1' } }, 1000)
  waitTool = reduceRun(waitTool, { type: 'tool-start', tool: { name: 'edit', callId: 'w2' } }, 1000)
  waitTool = reduceRun(waitTool, { type: 'needs-you', request: { id: 'd1', type: 'danger', summary: '写文件' } }, 1100)
  waitTool = reduceRun(waitTool, { type: 'tool-end', callId: 'w1' }, 1200)
  waitTool = reduceRun(waitTool, { type: 'request-answered', requestId: 'd1' }, 1300)
  assert.equal(waitTool.phase.activity, 'tool')
  assert.equal(waitTool.phase.tool.callId, 'w2')
  assert.equal(detectStall(done, 999999), null, '终态永不标记停滞')

  assert.deepEqual(normalizeThresholds({ noOutputMs: 1, toolSilentMs: 10 * 60_000 }), { noOutputMs: 30_000, toolSilentMs: 5 * 60_000 })
}

function runSignalMappingTests(main) {
  const sig = main.signalsFromPiEvent

  assert.deepEqual(sig({ type: 'agent_start' }), [{ type: 'agent-start' }])
  assert.deepEqual(sig({ type: 'agent_end', willRetry: true }), [{ type: 'agent-end', willRetry: true }])
  assert.deepEqual(sig({ type: 'agent_settled', aborted: true }), [{ type: 'agent-settled', aborted: true }])
  assert.deepEqual(sig({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta' } }), [{ type: 'activity', activity: 'thinking' }])
  assert.deepEqual(sig({ type: 'message_update', assistantMessageEvent: { type: 'text_delta' } }), [{ type: 'activity', activity: 'streaming' }])
  assert.deepEqual(sig({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start' } }), [{ type: 'activity', activity: 'streaming' }])
  assert.deepEqual(sig({ type: 'message_update', assistantMessageEvent: { type: 'text_end' } }), [])

  const tool = sig({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'edit', args: { path: 'src/a.ts' } })
  assert.equal(tool[0].type, 'tool-start')
  assert.equal(tool[0].tool.label, 'src/a.ts')
  assert.equal(tool[0].isWrite, true)

  const shell = sig({ type: 'tool_execution_start', toolCallId: 'c2', toolName: 'bash', args: { command: 'npm run build\nrm -rf' } })
  assert.equal(shell[0].tool.label, 'npm run build')

  assert.deepEqual(sig({ type: 'tool_execution_update', toolCallId: 'c1' }), [{ type: 'tool-update' }])
  const toolEnd = sig({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'edit', isError: false })
  assert.equal(toolEnd[0].isWrite, true)
  assert.equal(toolEnd[0].isError, false)
  const cancelled = sig({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'edit', isError: true, cancelled: true })
  assert.equal(cancelled[0].isError, false, '被取消不算失败')

  assert.deepEqual(sig({ type: 'compaction_start' }), [{ type: 'compaction-start' }])
  assert.deepEqual(sig({ type: 'compaction_end' }), [{ type: 'compaction-end' }])

  const retry = sig({ type: 'auto_retry_start', attempt: 2, maxAttempts: 3, delayMs: 5000, errorMessage: 'connection reset' }, 1000)
  assert.equal(retry[0].type, 'retry-start')
  assert.equal(retry[0].attempt, 2)
  assert.equal(retry[0].max, 3)
  assert.equal(retry[0].resumeAt, 6000)
  const quota = sig({ type: 'auto_retry_start', attempt: 1, maxAttempts: 5, delayMs: 1000, errorMessage: '429 rate limit' }, 1000)
  assert.equal(quota[0].type, 'rate-limit')
  assert.equal(quota[0].retry.resumeAt, 2000)
  const retryFail = sig({ type: 'auto_retry_end', success: false, finalError: 'invalid api key' })
  assert.equal(retryFail[0].type, 'retry-end')
  assert.equal(retryFail[0].success, false)
  assert.equal(retryFail[0].errorKind, 'auth')
  assert.deepEqual(sig({ type: 'auto_retry_end', success: true }), [{ type: 'retry-end', success: true }])

  const observed = sig({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'boom' } })
  assert.equal(observed[0].type, 'error-observed')

  const ui = main.runSignalFromUiRequest({ id: 'q1', method: 'confirm', title: '删除文件?' })
  assert.equal(ui.type, 'needs-you')
  assert.equal(ui.request.type, 'confirm')
  assert.equal(main.runSignalFromUiRequest({ id: 'q1', method: 'notify' }), null)
  assert.deepEqual(main.runSignalFromUiResolved('q1'), { type: 'request-answered', requestId: 'q1' })
  assert.equal(main.runSignalFromDangerConfirmation({ id: 'd1', summary: 'force push' }).request.type, 'danger')
  assert.equal(main.runSignalFromPiExit(1, null).type, 'pi-exit')
}

async function runRegistryTests(main, shared, dir) {
  const { RunRegistry, SessionCodeStore, MemoryRunHistory } = main

  {
    const errors = []
    const bare = new RunRegistry({ now: () => 1000, onError: (e) => errors.push(e) })
    assert.equal(bare.observe({ sessionId: 's1' }, { type: 'agent-start' }), null)
    assert.equal(errors.length, 1)
    assert.equal(errors[0].code, 'code-unavailable')
    assert.equal(bare.size(), 0)
  }

  const store = new SessionCodeStore({ root: dir, now: () => 1000 })
  await store.load()
  assert.equal(await store.assign('s1', 'session'), 'S1')
  assert.equal(await store.assign('s2', 'session'), 'S2')

  const history = new MemoryRunHistory()
  let clock = 1000
  const registry = new RunRegistry({ codes: store, history, now: () => clock })

  const ctx = { sessionId: 's1', title: '会话一', model: { provider: 'p', id: 'm', label: 'M' } }

  let snap = registry.observe(ctx, { type: 'queued', reason: 'concurrency' })
  assert.equal(snap.phase.kind, 'queued')
  const runId1 = snap.runId
  clock = 1100
  snap = registry.observe(ctx, { type: 'agent-start' })
  assert.equal(snap.runId, runId1)
  assert.equal(snap.phase.kind, 'running')
  assert.equal(snap.code, 'S1')

  clock = 1200
  registry.observePi(ctx, { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'edit', args: { path: 'a.ts' } })
  clock = 1300
  registry.observePi(ctx, { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'edit', isError: false })
  clock = 1400
  registry.observePi(ctx, { type: 'agent_settled', aborted: false })
  assert.equal(registry.get(runId1).phase.kind, 'done')
  assert.equal(registry.get(runId1).counts.tools, 1)
  assert.equal(registry.get(runId1).counts.edits, 1)
  await registry.whenIdle()
  assert.equal(history.records.length, 1)
  assert.equal(history.records[0].terminal, 'done')
  assert.equal(history.records[0].code, 'S1')
  assert.ok(history.records[0].segments.some((s) => s.phase === 'running'))

  clock = 1500
  assert.equal(registry.observe(ctx, { type: 'tool-end' }), null)
  assert.equal(registry.observe({ ...ctx, runId: runId1 }, { type: 'activity', activity: 'streaming' }), null)
  assert.equal(registry.get(runId1).phase.kind, 'done')

  clock = 1600
  snap = registry.observe(ctx, { type: 'agent-start' })
  assert.notEqual(snap.runId, runId1)
  assert.equal(snap.phase.kind, 'running')

  const genCtx = { ...ctx, generation: 2 }
  registry.open({ ...genCtx, runId: 'run-gen' })
  assert.equal(registry.observe({ ...ctx, generation: 1 }, { type: 'activity', activity: 'thinking' }), null)

  const waitCtx = { sessionId: 's2', generation: 1 }
  registry.open({ ...waitCtx, runId: 'run-wait' })
  registry.observe(waitCtx, { type: 'needs-you', request: { id: 'q1', type: 'danger', summary: '危险' } })
  registry.observe(waitCtx, { type: 'needs-you', request: { id: 'q2', type: 'select', summary: '选择' } })
  assert.equal(registry.get('run-wait').phase.kind, 'needs-you')
  registry.observeUiResolved(waitCtx, 'q1')
  assert.equal(registry.get('run-wait').phase.kind, 'needs-you')
  assert.equal(registry.get('run-wait').phase.request.id, 'q2')
  registry.observeUiResolved(waitCtx, 'q2')
  assert.equal(registry.get('run-wait').phase.kind, 'running')

  const loopCtx = { sessionId: 's2' }
  clock = 2000
  registry.markLoopAbort(loopCtx, '重复输出')
  assert.equal(registry.get('run-wait').phase.kind, 'stalled')
  registry.observe(loopCtx, { type: 'agent-settled', aborted: true })
  assert.equal(registry.get('run-wait').phase.kind, 'stalled')
  assert.equal(registry.get('run-wait').phase.cause, 'loop')

  const dangerCtx = { sessionId: 's2' }
  registry.observeDangerConfirmation(dangerCtx, { id: 'd1', summary: 'git push --force' })
  assert.equal(registry.get('run-wait').phase.kind, 'needs-you')

  assert.equal(registry.observe({ sessionId: 'unknown' }, { type: 'agent-start' }), null)

  const stallHistory = new MemoryRunHistory()
  let stallClock = 10_000
  const stallStore = new SessionCodeStore({ root: dir, now: () => stallClock })
  await stallStore.load()
  await stallStore.assign('s3', 'session')
  const stallRegistry = new RunRegistry({ codes: stallStore, history: stallHistory, now: () => stallClock })
  stallRegistry.open({ sessionId: 's3', runId: 'run-stall' }, { kind: 'running', since: stallClock, activity: 'waiting-model' })
  const marked = stallRegistry.tick(stallClock + 46_000)
  assert.deepEqual(marked, ['run-stall'])
  assert.equal(stallRegistry.get('run-stall').phase.kind, 'stalled')
  assert.equal(stallRegistry.get('run-stall').phase.cause, 'no-output')
  assert.equal(stallHistory.records.length, 0, '停滞不等于结束，不写历史')

  const monitorCalls = []
  const monitor = new main.StallMonitor({ tick: (now) => { monitorCalls.push(now); return [] }, now: () => 42, intervalMs: 1000 })
  assert.deepEqual(monitor.runOnce(), [])
  assert.deepEqual(monitorCalls, [42])

  const childStore = new SessionCodeStore({ root: dir })
  await childStore.load()
  await childStore.assign('s4', 'session')
  const childRegistry = new RunRegistry({ codes: childStore })
  const parentRun = childRegistry.open({ sessionId: 's4', runId: 'p1' })
  const child = childRegistry.open({ sessionId: 's4', kind: 'subagent', parentRunId: 'p1', runId: 'c1' })
  assert.equal(child.code, `${parentRun.code}·1`)
  const child2 = childRegistry.open({ sessionId: 's4', kind: 'subagent', parentRunId: 'p1', runId: 'c2' })
  assert.equal(child2.code, `${parentRun.code}·2`)
  assert.equal(child.parentRunId, 'p1')
  assert.equal(shared.formatChildCode('S12', 3), 'S12·3')
  const child3 = childRegistry.open({ sessionId: 's4', kind: 'subagent', parentSessionId: 's4', runId: 'c3' })
  assert.equal(child3.code, `${parentRun.code}·3`, '父运行实例不在时按父会话编号延续')
  assert.equal(child3.parentRunId, undefined)

  const order = registry.list().map((r) => r.phase.kind)
  const priorities = order.map((k) => shared.RUN_PHASE_ORDER[k])
  assert.deepEqual(priorities, [...priorities].sort((a, b) => a - b))
}

function runPublisherTests(main, shared) {
  const timers = fakeTimers()
  const batches = []
  const publisher = new main.RunPublisher({
    emit: (payload) => batches.push(payload),
    intervalMs: 250,
    setTimeout: timers.set,
    clearTimeout: timers.clear
  })
  const run = (runId, phase) => ({
    runId,
    code: 'S1',
    kind: 'session',
    sessionId: 's1',
    title: 't',
    startedAt: 0,
    phase,
    counts: { tools: 0, edits: 0, errors: 0 }
  })

  publisher.push(run('r1', { kind: 'running', since: 0, activity: 'thinking' }))
  publisher.push(run('r1', { kind: 'running', since: 0, activity: 'streaming' }))
  publisher.push(run('r2', { kind: 'queued', since: 0, reason: 'followup' }))
  assert.equal(batches.length, 0)
  assert.equal(timers.pending().length, 1)
  timers.runDue()
  assert.equal(batches.length, 1)
  assert.deepEqual(batches[0].upsert.map((r) => r.runId).sort(), ['r1', 'r2'])
  assert.equal(batches[0].upsert.find((r) => r.runId === 'r1').phase.activity, 'streaming')

  publisher.push(run('r3', { kind: 'needs-you', since: 0, request: { id: 'q', type: 'confirm', summary: 's' } }))
  assert.equal(batches.length, 2)
  publisher.push(run('r4', { kind: 'failed', at: 0, cause: 'model-error', message: 'x', seen: false }))
  assert.equal(batches.length, 3)
  publisher.push(run('r5', { kind: 'done', at: 0, seen: false }))
  assert.equal(batches.length, 4)
  assert.equal(shared.isImmediatePhase(run('r5', { kind: 'done', at: 0, seen: false }).phase), true)

  publisher.remove('r1')
  assert.equal(batches.length, 5)
  assert.deepEqual(batches[4], { upsert: [], remove: ['r1'] })

  publisher.dispose()
}

async function runSessionCodeTests(main, dir) {
  const { SessionCodeStore, formatRunCode, sessionCodesPath } = main
  assert.equal(formatRunCode('session', 12), 'S12')
  assert.equal(formatRunCode('scheduled', 3), 'T03')
  assert.equal(formatRunCode('review', 4), 'R04')

  const root = join(dir, 'codes-ok')
  const store = new SessionCodeStore({ root })
  await store.load()
  assert.equal(await store.assign('a', 'session'), 'S1')
  assert.equal(await store.assign('b', 'session'), 'S2')
  assert.equal(await store.assign('t1', 'scheduled'), 'T01')
  assert.equal(await store.assign('r1', 'review'), 'R01')
  assert.equal(await store.assign('a', 'session'), 'S1', '已有编号不重复分配')
  const reloaded = new SessionCodeStore({ root })
  await reloaded.load()
  assert.equal(reloaded.codeFor('b'), 'S2')
  assert.equal(reloaded.codeFor('t1'), 'T01')

  const backfillRoot = join(dir, 'codes-backfill')
  const backfill = new SessionCodeStore({ root: backfillRoot })
  await backfill.load()
  const assigned = await backfill.backfill([
    { scopeId: 'new', kind: 'session', createdAt: 3000 },
    { scopeId: 'old', kind: 'session', createdAt: 1000 },
    { scopeId: 'mid', kind: 'session', createdAt: 2000 },
    { scopeId: 'old', kind: 'session', createdAt: 500 }
  ])
  assert.equal(assigned, 3, '重复 scopeId 只补一次')
  assert.equal(backfill.codeFor('old'), 'S1')
  assert.equal(backfill.codeFor('mid'), 'S2')
  assert.equal(backfill.codeFor('new'), 'S3')
  assert.equal(await backfill.backfill([{ scopeId: 'new', kind: 'session', createdAt: 3000 }]), 0, '重复启动不再改已存在的编号')
  assert.equal(backfill.codeFor('new'), 'S3')

  const failRoot = join(dir, 'codes-fail')
  const failing = new SessionCodeStore({ root: failRoot, write: async () => { throw new Error('disk full') } })
  await failing.load()
  await assert.rejects(() => failing.assign('x', 'session'), /disk full/)
  assert.equal(failing.codeFor('x'), undefined, '落盘失败时内存里不能先有编号')
  await assert.rejects(() => readFile(sessionCodesPath(failRoot), 'utf8'))
}

async function runHistoryTests(main, dir) {
  const { DurableRunHistory, runHistoryPath } = main
  const written = []
  const root = join(dir, 'hist')
  const history = new DurableRunHistory(root, { write: async (path, text, mode) => { written.push({ path, text, mode }) } })
  const at = new Date(2026, 0, 2, 12, 0, 0).getTime()
  await history.append({
    runId: 'r1', code: 'S1', kind: 'session', sessionId: 's1', title: 't', startedAt: at, endedAt: at,
    terminal: 'done', segments: [{ phase: 'running', from: at, to: at }], counts: { tools: 0, edits: 0, errors: 0 }
  })
  assert.equal(written.length, 1)
  assert.equal(written[0].path, runHistoryPath(at, root))
  assert.match(written[0].path, /2026-01-02\.jsonl$/)
  assert.equal(written[0].mode, 'append')
  assert.equal(JSON.parse(written[0].text).runId, 'r1')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runV3RunsTests()
  console.log('v3-runs: 全部通过')
}
