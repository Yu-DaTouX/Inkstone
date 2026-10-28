import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

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

async function runV3RunsHostTests() {
  const dir = await mkdtemp(join(tmpdir(), 'inkstone-v3-runs-host-'))
  try {
    const hostMod = await compile('src/main/runs-host.ts', join(dir, 'host.mjs'))
    const pushes = []
    let seq = 0
    let now = 1_000
    const root = join(dir, 'data')
    const host = await hostMod.createRunsHost({
      root,
      push: (msg) => pushes.push(msg),
      now: () => now,
      newRunId: () => `run-${++seq}`
    })

    let snap = host.snapshot()
    assert.equal(snap.revision, 0)
    assert.deepEqual(snap.runs, [])

    const observe = host.observerFor({ generation: 1 })
    const ctx1 = { sessionId: 's1', sessionPath: '/tmp/s1.jsonl', title: '会话一', model: { provider: 'p', id: 'm', label: 'M' } }
    observe(ctx1, { type: 'agent-start' })
    assert.equal(host.snapshot().runs.length, 0, '编号分配完成前不登记运行（但已缓冲，不丢 agent_start）')
    await waitFor(() => host.snapshot().runs.length === 1)
    now = 2_000
    observe(ctx1, { type: 'activity', activity: 'streaming' })
    observe(ctx1, { type: 'agent-settled', aborted: false })
    snap = host.snapshot()
    assert.equal(snap.runs.length, 1)
    assert.equal(snap.runs[0].phase.kind, 'done', 'agent_settled 才是终态依据')
    assert.equal(snap.runs[0].code, 'S1')
    assert.equal(snap.runs[0].sessionId, 's1')
    assert.equal(snap.runs[0].title, '会话一')
    assert.equal(snap.runs[0].model.label, 'M')
    assert.ok(snap.revision > 0, 'snapshot 返回的 revision 必须 > 0')

    const ctx2 = { sessionId: 's2' }
    observe(ctx2, { type: 'agent-start' })
    await waitFor(() => host.snapshot().runs.some((r) => r.sessionId === 's2'))
    pushes.length = 0
    observe(ctx2, { type: 'activity', activity: 'thinking' })
    assert.equal(pushes.length, 0, '非状态类变化先留在合并窗口里')
    const flushed = host.snapshot()
    assert.equal(pushes.length, 1, 'snapshot 同步冲出待发增量')
    assert.equal(pushes[0].ch, 'runs')
    assert.equal(pushes[0].payload.revision, flushed.revision, 'push 的 revision 与 snapshot 返回一致')
    assert.equal(flushed.runs.find((r) => r.sessionId === 's2').phase.activity, 'thinking')

    const revisions = pushes.map((p) => p.payload.revision)
    assert.deepEqual(revisions, [...revisions].sort((a, b) => a - b))

    const doneRun = flushed.runs.find((r) => r.sessionId === 's1')
    const seen = host.markSeen(doneRun.runId)
    assert.equal(seen.ok, true)
    assert.equal(host.markSeen('不存在').ok, false)
    const marked = host.snapshot().runs.find((r) => r.runId === doneRun.runId)
    assert.equal(marked.phase.seen, true)

    const ctx3 = { sessionId: 's3' }
    observe(ctx3, { type: 'agent-start' })
    await waitFor(() => host.snapshot().runs.some((r) => r.sessionId === 's3'))
    host.observeApproval({ id: 'danger-1', kind: 'danger', sessionId: 's3', title: '危险操作确认' })
    assert.equal(host.snapshot().runs.find((r) => r.sessionId === 's3').phase.kind, 'needs-you')
    host.observeApproval({ id: 'consent-1', kind: 'consent', sessionId: 's3', title: '普通同意' })
    assert.equal(
      host.snapshot().runs.find((r) => r.sessionId === 's3').phase.kind,
      'needs-you',
      '普通同意也是阻塞请求，但只是观察正式请求，不执行或授权'
    )
    host.resolveApproval('danger-1')
    assert.equal(host.snapshot().runs.find((r) => r.sessionId === 's3').phase.kind, 'needs-you', '还有另一个同意请求时不能提前恢复运行态')
    host.resolveApproval('consent-1')
    assert.equal(host.snapshot().runs.find((r) => r.sessionId === 's3').phase.kind, 'running', '全部请求 resolved 后才恢复，拒绝 / 超时同样算 resolved')
    for (const kind of ['outside', 'permission', 'delete', 'move']) {
      const id = `approval-${kind}`
      host.observeApproval({ id, kind, sessionId: 's3', title: `${kind} 确认` })
      assert.equal(host.snapshot().runs.find((r) => r.sessionId === 's3').phase.kind, 'needs-you', `${kind} 批准也必须显示等待用户`)
      host.resolveApproval(id)
      assert.equal(host.snapshot().runs.find((r) => r.sessionId === 's3').phase.kind, 'running')
    }

    observe(ctx3, { type: 'pi-exit', code: 1, signal: null })
    const failed = host.snapshot().runs.find((r) => r.sessionId === 's3')
    assert.equal(failed.phase.kind, 'failed')
    assert.equal(failed.phase.cause, 'pi-exit')

    const s2Run = host.snapshot().runs.find((r) => r.sessionId === 's2')
    host.observeSubagentEvent(
      { id: 'sub-1', parentSessionId: 's2', task: '子任务' },
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta' } }
    )
    const sub = host.snapshot().runs.find((r) => r.kind === 'subagent')
    assert.equal(sub.code, 'S2·1', '子 Agent 归到父会话编号下')
    assert.equal(sub.parentRunId, s2Run.runId)
    host.observeSubagentEvent({ id: 'sub-1', parentSessionId: 's2' }, { type: 'agent_end', willRetry: false })
    assert.equal(host.snapshot().runs.find((r) => r.kind === 'subagent').phase.kind, 'running', 'agent_end 不是终态')
    host.observeSubagentEvent({ id: 'sub-1', parentSessionId: 's2' }, { type: 'agent_settled', aborted: false })
    assert.equal(host.snapshot().runs.find((r) => r.kind === 'subagent').phase.kind, 'done', 'agent_settled 才是子代理终态')

    await host.dispose()
    const beforeCount = host.snapshot().runs.length
    observe(ctx1, { type: 'agent-start' })
    assert.equal(host.snapshot().runs.length, beforeCount, 'dispose 后不再登记新运行')

    const historyFiles = await readdir(join(root, 'runs'))
    assert.ok(historyFiles.some((name) => name.endsWith('.jsonl')), '运行历史写盘完成（dispose 已等待）')

    {
      const retryRoot = join(dir, 'retry-code')
      const retryPushes = []
      const retryHost = await hostMod.createRunsHost({ root: retryRoot, push: (msg) => retryPushes.push(msg), now: () => 1_000, newRunId: () => 'run-retry' })
      const blocked = join(retryRoot, 'session-codes.json')
      await mkdir(blocked, { recursive: true })
      retryHost.observerFor()({ sessionId: 's-retry' }, { type: 'agent-start' })
      await new Promise((resolve) => setTimeout(resolve, 100))
      assert.equal(retryHost.snapshot().runs.length, 0, '编号分配失败时运行先排队，不丢 agent_start')
      await rm(blocked, { recursive: true, force: true })
      await waitFor(() => retryHost.snapshot().runs.some((r) => r.sessionId === 's-retry'))
      assert.equal(retryHost.snapshot().runs.find((r) => r.sessionId === 's-retry').phase.kind, 'running', '编号分配重试成功后补登记排队中的信号')
      assert.equal(retryPushes.filter((msg) => msg.ch === 'notify').length, 0, '单次失败只重试，不打扰用户')
      await retryHost.dispose()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function messageEvent(kind) {
  return { type: 'message_update', assistantMessageEvent: { type: kind } }
}

async function runV3RunsSubagentTests() {
  const dir = await mkdtemp(join(tmpdir(), 'inkstone-v3-runs-subagent-'))
  try {
    const hostMod = await compile('src/main/runs-host.ts', join(dir, 'host.mjs'))
    const runsMod = await compile('src/main/runs/index.ts', join(dir, 'runs.mjs'))

    {
      const pushes = []
      let seq = 0
      let now = 1_000
      const host = await hostMod.createRunsHost({
        root: join(dir, 'subagent-code'),
        push: (msg) => pushes.push(msg),
        now: () => now,
        newRunId: () => `run-${++seq}`
      })

      const observe = host.observerFor()
      observe({ sessionId: 's1', title: '父会话' }, { type: 'agent-start' })
      await waitFor(() => host.snapshot().runs.length === 1)
      const parent = host.snapshot().runs.find((r) => r.kind === 'session')
      assert.equal(parent.code, 'S1')

      host.observeSubagentEvent(
        { id: 'sub-a', parentSessionId: 's1', task: '子任务 A', model: 'p/m', thinkingLevel: 'high' },
        messageEvent('thinking_delta')
      )
      await waitFor(() => host.snapshot().runs.some((r) => r.kind === 'subagent'))
      let child = host.snapshot().runs.find((r) => r.kind === 'subagent')
      assert.equal(child.code, 'S1·1', '子 Agent 归到父会话编号下')
      assert.equal(child.parentRunId, parent.runId, '子行挂回父运行实例')
      assert.equal(child.kind, 'subagent')
      assert.equal(child.model.label, 'p/m')
      assert.equal(child.model.thinking, 'high')
      assert.notEqual(child.sessionId, parent.sessionId, '子运行不共用父会话作用域')
      const childRunId = child.runId

      now = 1_500
      host.observeSubagentEvent(
        { id: 'sub-a', parentSessionId: 's1' },
        { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'ls' } }
      )
      assert.equal(host.snapshot().runs.filter((r) => r.kind === 'subagent').length, 1)
      assert.equal(host.snapshot().runs.find((r) => r.kind === 'subagent').runId, childRunId)
      assert.equal(host.snapshot().runs.find((r) => r.kind === 'subagent').code, 'S1·1')

      host.observeSubagentEvent({ id: 'sub-a', parentSessionId: 's1' }, { type: 'agent_end', willRetry: false })
      assert.equal(host.snapshot().runs.find((r) => r.runId === childRunId).phase.kind, 'running', 'agent_end 不是终态')

      host.observeSubagentEvent(
        { id: 'sub-b', parentSessionId: 's1', task: `只读调研任务\n${'很长的任务说明'.repeat(80)}`, brief: { title: '画布预览调研' } },
        messageEvent('text_delta')
      )
      await waitFor(() => host.snapshot().runs.filter((r) => r.kind === 'subagent').length === 2)
      assert.equal(host.snapshot().runs.find((r) => r.code === 'S1·2').title, '画布预览调研', '子 Agent 运行标题用短标题，不用任务全文')
      assert.deepEqual(
        host.snapshot().runs.filter((r) => r.kind === 'subagent').map((r) => r.code).sort(),
        ['S1·1', 'S1·2']
      )

      now = 2_000
      host.observeSubagentEvent({ id: 'sub-a', parentSessionId: 's1' }, { type: 'agent_settled', aborted: false })
      assert.equal(host.snapshot().runs.find((r) => r.runId === childRunId).phase.kind, 'done')
      assert.equal(host.snapshot().runs.find((r) => r.code === 'S1·2').phase.kind, 'running', '另一个子代理不受影响')

      const beforeTotal = host.snapshot().runs.length
      host.observeSubagentEvent({ id: 'sub-a', parentSessionId: 's1' }, messageEvent('text_delta'))
      assert.equal(host.snapshot().runs.length, beforeTotal, '终态子代理的迟到事件不新建运行')
      assert.equal(host.snapshot().runs.find((r) => r.runId === childRunId).phase.kind, 'done')
      assert.equal(host.snapshot().runs.filter((r) => r.kind === 'subagent').length, 2)

      host.observeSubagentEvent({ id: 'sub-a', parentSessionId: 's1', activeSince: 3_000 }, messageEvent('text_delta'))
      const resumed = host.snapshot().runs.filter((r) => r.kind === 'subagent' && r.sessionId === 'subagent:sub-a')
      assert.ok(resumed.some((r) => r.runId !== childRunId && r.phase.kind === 'running'), '\u7eed\u63a5\u540e\u7684\u65b0\u6fc0\u6d3b\u91cd\u65b0\u5f00\u4e00\u6bb5\u8fd0\u884c')
      host.observeSubagentEvent({ id: 'sub-a', parentSessionId: 's1', activeSince: 3_000 }, { type: 'agent_settled', aborted: false })

      host.settleSubagent({ id: 'sub-b', parentSessionId: 's1' }, 'stopped')
      assert.ok(['stopped', 'cancelled', 'aborted'].includes(host.snapshot().runs.find((r) => r.code === 'S1·2').phase.kind) || host.snapshot().runs.find((r) => r.code === 'S1·2').phase.kind !== 'running', '\u5b50 Agent \u505c\u6b62\u540e\u8fdb\u5165\u7ec8\u6001')
      host.settleSubagent({ id: 'sub-never', parentSessionId: 's1' }, 'failed', 'x')
      assert.equal(host.snapshot().runs.length, beforeTotal + 1, '\u672a\u767b\u8bb0\u7684\u5b50 Agent \u4e0d\u65b0\u5efa\u8fd0\u884c')

      host.observeSubagentEvent({ id: 'sub-orphan' }, { type: 'agent_start' })
      assert.equal(host.snapshot().runs.length, beforeTotal + 1)

      await host.dispose()
    }

    {
      const { SessionCodeStore } = runsMod

      const store = new SessionCodeStore({ root: join(dir, 'codes-a') })
      await store.load()
      const items = [
        { scopeId: 'new', kind: 'session', createdAt: 3000 },
        { scopeId: 'old', kind: 'session', createdAt: 1000 },
        { scopeId: 'mid', kind: 'session', createdAt: 2000 },
        { scopeId: 'old', kind: 'session', createdAt: 500 },
        { scopeId: 'mid', kind: 'session', createdAt: 2000 }
      ]
      assert.equal(await store.backfill(items), 3, '同一 scopeId 重复出现只补一次')
      assert.equal(store.codeFor('old'), 'S1')
      assert.equal(store.codeFor('mid'), 'S2')
      assert.equal(store.codeFor('new'), 'S3')
      assert.equal(store.entries().filter((e) => e.scopeId === 'old').length, 1, '不因重复输入白耗号段')

      assert.equal(await store.backfill(items), 0)
      assert.equal(store.codeFor('new'), 'S3')

      const tied = new SessionCodeStore({ root: join(dir, 'codes-b') })
      await tied.load()
      await tied.backfill([
        { scopeId: 'b', kind: 'session', createdAt: 1000 },
        { scopeId: 'a', kind: 'session', createdAt: 1000 }
      ])
      assert.equal(tied.codeFor('a'), 'S1')
      assert.equal(tied.codeFor('b'), 'S2')

      const existing = new SessionCodeStore({ root: join(dir, 'codes-c') })
      await existing.load()
      assert.equal(await existing.assign('existing', 'session'), 'S1')
      assert.equal(await existing.backfill([{ scopeId: 'x', kind: 'session', createdAt: 1000 }]), 1)
      assert.equal(existing.codeFor('existing'), 'S1')
      assert.equal(existing.codeFor('x'), 'S2')

      const kinds = new SessionCodeStore({ root: join(dir, 'codes-d') })
      await kinds.load()
      await kinds.backfill([
        { scopeId: 'sess', kind: 'session', createdAt: 1000 },
        { scopeId: 'task', kind: 'scheduled', createdAt: 1000 }
      ])
      assert.equal(kinds.codeFor('sess'), 'S1')
      assert.equal(kinds.codeFor('task'), 'T01')
    }

    console.log('v3 子 Agent 归约：S{n}·{k} 稳定 / agent_settled 终态 / 补号确定且幂等 全部通过')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function compileOnly(entry, outfile) {
  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  return outfile
}

function fakeIpc() {
  const handlers = new Map()
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    rawHandle: (channel, fn) => handlers.set(channel, fn),
    has: (channel) => handlers.has(channel),
    invoke: (channel, ...args) => {
      const fn = handlers.get(channel)
      if (!fn) throw new Error(`没有注册 ${channel}`)
      return fn(...args)
    }
  }
}

function record(overrides = {}) {
  const endedAt = overrides.endedAt ?? Date.parse('2026-01-02T12:00:00')
  return {
    runId: overrides.runId ?? `r-${endedAt}`,
    code: overrides.code ?? 'S1',
    kind: overrides.kind ?? 'session',
    sessionId: overrides.sessionId ?? 's1',
    title: overrides.title ?? '任务',
    startedAt: overrides.startedAt ?? endedAt - 60_000,
    endedAt,
    terminal: overrides.terminal ?? 'done',
    segments: overrides.segments ?? [{ phase: 'running', from: overrides.startedAt ?? endedAt - 60_000, to: endedAt }],
    counts: overrides.counts ?? { tools: 1, edits: 0, errors: 0 },
    ...(overrides.model ? { model: overrides.model } : {}),
    ...(overrides.projectId ? { projectId: overrides.projectId } : {}),
    ...(overrides.message ? { message: overrides.message } : {})
  }
}

function runSnapshot(runId, phase, overrides = {}) {
  return {
    runId,
    code: overrides.code ?? 'S1',
    kind: overrides.kind ?? 'session',
    sessionId: overrides.sessionId ?? 's1',
    ...(overrides.sessionPath ? { sessionPath: overrides.sessionPath } : {}),
    title: overrides.title ?? '任务',
    startedAt: 1_000,
    phase,
    counts: { tools: 0, edits: 0, errors: 0 }
  }
}

export async function runV3RunsIpcTests() {
  const dir = await mkdtemp(join(tmpdir(), 'inkstone-v3-runs-ipc-'))
  const dataRoot = join(dir, 'data')
  const outfile = join(dir, 'runs-ipc.mjs')
  try {
    await compileOnly('src/main/ipc/runs-ipc.ts', outfile)
    process.env.YAN_DATA_DIR = dataRoot
    const mod = await import(pathToFileURL(outfile).href)

    await runHistoryTests(mod, dataRoot)
    await runStopTests(mod)
    await runRegistrarTests(mod)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function runHistoryTests(mod, dataRoot) {
  const days = ['2026-01-02', '2026-01-03']
  await mkdir(join(dataRoot, 'runs'), { recursive: true })

  const day2 = [
    record({ runId: 'a', endedAt: Date.parse('2026-01-02T09:00:00'), terminal: 'done', sessionId: 's1' }),
    '{ 这不是 JSON',
    '',
    JSON.stringify(record({ runId: 'b', endedAt: Date.parse('2026-01-02T10:00:00'), terminal: 'failed', title: '构建失败' })),
    JSON.stringify([1, 2, 3]),
    record({ runId: 'c', endedAt: Date.parse('2026-01-02T11:00:00'), terminal: 'stopped', kind: 'subagent' }),
    'x'.repeat(512 * 1024 + 10)
  ].map((line) => (typeof line === 'string' ? line : JSON.stringify(line)))
  await writeFile(join(dataRoot, 'runs', `${days[0]}.jsonl`), `${day2.join('\n')}\n`, 'utf8')

  const day3 = [
    record({ runId: 'd', endedAt: Date.parse('2026-01-03T09:00:00'), terminal: 'done', title: '第二天' })
  ]
  await writeFile(join(dataRoot, 'runs', `${days[1]}.jsonl`), `${day3.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')

  const single = await mod.readRunsHistory({ date: days[0] }, dataRoot)
  assert.equal(single.ok, true)
  assert.deepEqual(single.records.map((r) => r.runId).sort(), ['a', 'b', 'c'])
  assert.deepEqual(single.days, [days[0]])
  assert.equal(single.truncated, false)
  assert.equal(single.records[0].runId, 'c', '按结束时间倒序')

  const limited = await mod.readRunsHistory({ date: days[0], limit: 2 }, dataRoot)
  assert.equal(limited.records.length, 2)
  assert.equal(limited.truncated, true)

  const ranged = await mod.readRunsHistory({ range: { from: days[0], to: days[1] } }, dataRoot)
  assert.deepEqual(ranged.days, days)
  assert.deepEqual(ranged.records.map((r) => r.runId), ['d', 'c', 'b', 'a'])
  assert.equal(ranged.truncated, false)

  const onlyFailed = await mod.readRunsHistory({ date: days[0], filters: { terminal: ['failed'] } }, dataRoot)
  assert.deepEqual(onlyFailed.records.map((r) => r.runId), ['b'])
  const onlySub = await mod.readRunsHistory({ date: days[0], filters: { kind: ['subagent'] } }, dataRoot)
  assert.deepEqual(onlySub.records.map((r) => r.runId), ['c'])
  const bySession = await mod.readRunsHistory({ date: days[0], filters: { sessionId: 's1' } }, dataRoot)
  assert.equal(bySession.records.length, 3)
  const byTitle = await mod.readRunsHistory({ date: days[0], filters: { query: '构建' } }, dataRoot)
  assert.deepEqual(byTitle.records.map((r) => r.runId), ['b'])

  const missing = await mod.readRunsHistory({ date: '2025-12-31' }, dataRoot)
  assert.equal(missing.ok, true)
  assert.deepEqual(missing.records, [])

  const bad = await mod.readRunsHistory({ date: '2026/01/02' }, dataRoot)
  assert.equal(bad.ok, false)
  assert.match(bad.error, /日期/)
  const both = await mod.readRunsHistory({ date: days[0], range: { from: days[0] } }, dataRoot)
  assert.equal(both.ok, false)
  const tooLong = await mod.readRunsHistory({ range: { from: '2026-01-01', to: '2026-03-01' } }, dataRoot)
  assert.equal(tooLong.ok, false)
  assert.match(tooLong.error, /31/)

  assert.deepEqual(mod.resolveHistoryDays({ date: '2026-01-02' }).days, ['2026-01-02'])
  assert.deepEqual(mod.resolveHistoryDays({ range: { from: '2026-01-01', to: '2026-01-03' } }).days, [
    '2026-01-01',
    '2026-01-02',
    '2026-01-03'
  ])

  const ipc = fakeIpc()
  mod.registerRunsIpc(ipc, {
    snapshot: () => ({ revision: 0, runs: [] }),
    markSeen: () => ({ ok: false }),
    stopSessionRun: async () => ({ ok: true }),
    stopSubagentRun: async () => ({ ok: true })
  })
  const viaIpc = await ipc.invoke('yan:runs:history', { date: days[0] })
  assert.equal(viaIpc.ok, true)
  assert.deepEqual(viaIpc.records.map((r) => r.runId).sort(), ['a', 'b', 'c'])
}

async function runStopTests(mod) {
  const ipc = fakeIpc()
  const calls = { session: [], subagent: [] }
  const state = {
    runs: [
      runSnapshot('run-live', { kind: 'running', since: 0, activity: 'streaming' }, { sessionId: 's-live', code: 'S1' }),
      runSnapshot('run-done', { kind: 'done', at: 5000, seen: true }, { sessionId: 's-done', code: 'S2' }),
      runSnapshot('run-child', { kind: 'running', since: 0, activity: 'subagent' }, { sessionId: 's-live', code: 'S1·1', kind: 'subagent' }),
      runSnapshot('run-scheduled', { kind: 'running', since: 0, activity: 'waiting-model' }, { sessionId: 's-t', code: 'T01', kind: 'scheduled' })
    ]
  }
  const fakeController = {
    aborted: 0,
    async abort() {
      this.aborted += 1
      state.runs = state.runs.map((run) =>
        run.runId === 'run-live' ? { ...run, phase: { kind: 'stopped', at: 9000, by: 'user' } } : run
      )
    }
  }

  mod.registerRunsIpc(ipc, {
    snapshot: () => ({ revision: 7, runs: state.runs }),
    markSeen: (runId) => ({ ok: runId === 'run-done' }),
    stopSessionRun: async ({ sessionId, sessionPath }) => {
      calls.session.push({ sessionId, sessionPath })
      await fakeController.abort()
      return { ok: true }
    },
    stopSubagentRun: async (runId) => {
      calls.subagent.push(runId)
      state.runs = state.runs.map((run) =>
        run.runId === runId ? { ...run, phase: { kind: 'stopped', at: 9000, by: 'user' } } : run
      )
      return { ok: true }
    }
  })

  const unknown = await ipc.invoke('yan:runs:stop', 'run-missing')
  assert.equal(unknown.ok, false)
  assert.equal(calls.session.length, 0)
  assert.equal(calls.subagent.length, 0)
  assert.equal((await ipc.invoke('yan:runs:stop', '   ')).ok, false)
  assert.equal((await ipc.invoke('yan:runs:stop', 123)).ok, false)

  const done = await ipc.invoke('yan:runs:stop', 'run-done')
  assert.equal(done.ok, false)
  assert.equal(calls.session.length, 0)

  const live = await ipc.invoke('yan:runs:stop', 'run-live')
  assert.deepEqual(live, { ok: true, runId: 'run-live', kind: 'session' })
  assert.equal(calls.session.length, 1)
  assert.equal(calls.session[0].sessionId, 's-live')
  assert.equal(fakeController.aborted, 1)
  assert.equal(calls.subagent.length, 0)

  const again = await ipc.invoke('yan:runs:stop', 'run-live')
  assert.equal(again.ok, false)
  assert.equal(fakeController.aborted, 1)

  const child = await ipc.invoke('yan:runs:stop', 'run-child')
  assert.deepEqual(child, { ok: true, runId: 'run-child', kind: 'subagent' })
  assert.deepEqual(calls.subagent, ['run-child'])
  assert.equal(fakeController.aborted, 1)

  const scheduled = await ipc.invoke('yan:runs:stop', 'run-scheduled')
  assert.equal(scheduled.ok, false)
  assert.equal(scheduled.kind, 'scheduled')

  const failing = fakeIpc()
  mod.registerRunsIpc(failing, {
    snapshot: () => ({ revision: 0, runs: [runSnapshot('run-x', { kind: 'running', since: 0, activity: 'streaming' })] }),
    markSeen: () => ({ ok: false }),
    stopSessionRun: async () => ({ ok: false, error: '实例已退出' }),
    stopSubagentRun: async () => ({ ok: false })
  })
  const failed = await failing.invoke('yan:runs:stop', 'run-x')
  assert.deepEqual(failed, { ok: false, error: '实例已退出', runId: 'run-x' })

  const recovering = fakeIpc()
  mod.registerRunsIpc(recovering, {
    snapshot: () => ({ revision: 0, runs: [runSnapshot('run-q', { kind: 'running', since: 0, activity: 'streaming' })] }),
    markSeen: () => ({ ok: false }),
    stopSessionRun: async () => ({
      ok: true,
      recovered: { steering: ['排队的插话'], followUp: ['排在后面的补充'] }
    }),
    stopSubagentRun: async () => ({ ok: false })
  })
  const recovered = await recovering.invoke('yan:runs:stop', 'run-q')
  assert.deepEqual(recovered, {
    ok: true,
    runId: 'run-q',
    kind: 'session',
    recovered: { steering: ['排队的插话'], followUp: ['排在后面的补充'] }
  })
}

async function runRegistrarTests(mod) {
  const ipc = fakeIpc()
  const marked = []
  mod.registerRunsIpc(ipc, {
    snapshot: () => ({ revision: 3, runs: [] }),
    markSeen: (runId) => {
      marked.push(runId)
      return { ok: true }
    },
    stopSessionRun: async () => ({ ok: true }),
    stopSubagentRun: async () => ({ ok: true })
  })

  assert.ok(ipc.has('yan:runs:snapshot'))
  assert.ok(ipc.has('yan:runs:markSeen'))
  assert.ok(ipc.has('yan:runs:history'))
  assert.ok(ipc.has('yan:runs:stop'))
  assert.deepEqual(await ipc.invoke('yan:runs:snapshot'), { revision: 3, runs: [] })
  await ipc.invoke('yan:runs:markSeen', 'r1')
  await ipc.invoke('yan:runs:markSeen', 42)
  assert.deepEqual(marked, ['r1', ''])
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runV3RunsHostTests()
  console.log('v3-runs-host: 全部通过')
  await runV3RunsSubagentTests()
  await runV3RunsIpcTests()
  console.log('v3-runs-ipc: 全部通过')
}
