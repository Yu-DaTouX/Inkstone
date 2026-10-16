/**
 * 定时运行 T 编号与正式 registry producer 专项测试（v3 WP-51 接线）。
 *
 * 现场用 esbuild 编译 `src/main/runs/scheduled-origin.ts` 与 `src/main/runs-host.ts`，
 * 在隔离临时目录里跑：不启动 Electron、不碰 pi、不写用户数据目录。
 *
 *   node scripts/test-v3-scheduled-runs.mjs
 *
 * 覆盖：来源规范化、会话优先/代次退化的双键表、openScheduled 发送前登记 T、
 * 发送前早期信号不分 S、定时会话子运行 T01·n、普通会话与子运行编号不变、
 * 终态后迟到事件不复活、失败以同一 ctx 收口、同一任务多次运行各自独立、
 * 选择期绑定的懒登记、编号持久 kind 不改。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
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

async function readCodes(root) {
  try {
    return JSON.parse(await readFile(join(root, 'session-codes.json'), 'utf8'))
  } catch {
    return { version: 1, entries: [] }
  }
}

async function readHistory(root) {
  const dir = join(root, 'runs')
  let names
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const records = []
  for (const name of names.filter((item) => item.endsWith('.jsonl'))) {
    const text = await readFile(join(dir, name), 'utf8')
    for (const line of text.split('\n')) {
      if (line.trim()) records.push(JSON.parse(line))
    }
  }
  return records
}

async function run() {
  const dir = await mkdtemp(join(tmpdir(), 'inkstone-v3-scheduled-'))
  try {
    const origin = await compile('src/main/runs/scheduled-origin.ts', join(dir, 'origin.mjs'))
    const hostMod = await compile('src/main/runs-host.ts', join(dir, 'host.mjs'))

    /* ── 纯助手：来源规范化与上下文构造 ── */
    assert.equal(origin.normalizeScheduledOrigin('  '), null)
    assert.equal(origin.normalizeScheduledOrigin(undefined), null)
    assert.deepEqual(origin.normalizeScheduledOrigin(' task '), { kind: 'scheduled', scopeId: 'task' })
    const built = origin.scheduledRunContext(
      { sessionId: 's', sessionPath: '/p.jsonl', title: 'T', model: { provider: 'p', id: 'm', label: 'M' }, generation: 3 },
      { kind: 'scheduled', scopeId: 'task' },
      { code: 'T01', runId: 'run-x' }
    )
    assert.equal(built.kind, 'scheduled')
    assert.equal(built.scopeId, 'task')
    assert.equal(built.code, 'T01')
    assert.equal(built.runId, 'run-x')
    assert.equal(built.sessionId, 's')
    assert.equal(built.generation, 3)
    assert.equal(built.sessionPath, '/p.jsonl')

    /* ── 双键来源表：会话优先，代次只作退化键，绝不给未知会话兜底 ── */
    const table = new origin.ScheduledOriginTable()
    table.bind({ kind: 'scheduled', scopeId: 't1' }, { sessionId: 's1', generation: 7 })
    assert.equal(table.resolve({ sessionId: 's1' }).scopeId, 't1')
    assert.equal(table.resolve({ generation: 7 }).scopeId, 't1')
    table.bind({ kind: 'scheduled', scopeId: 't2' }, { generation: 9 })
    assert.equal(table.resolve({ sessionId: 'other', generation: 9 }), undefined, '会话没绑定时不能用代次兜底')
    assert.equal(table.resolve({ generation: 9 }).scopeId, 't2')
    table.clear({ sessionId: 's1' })
    assert.equal(table.resolve({ sessionId: 's1' }), undefined)
    assert.equal(table.resolve({ generation: 7 }).scopeId, 't1', '清除会话键不动代次键')
    table.reset()
    assert.equal(table.size(), 0)

    /* ── 宿主流程 ── */
    const root = join(dir, 'data')
    const pushes = []
    let seq = 0
    let now = 1_000
    const host = await hostMod.createRunsHost({
      root,
      push: (msg) => pushes.push(msg),
      now: () => now,
      newRunId: () => `run-${++seq}`
    })

    // 1. 发送前 openScheduled：按 kind:'scheduled' + scopeId 登记，编号 T01。
    const schedObs = host.observerFor({ generation: 11 })
    const handle = await host.openScheduled({ scopeId: 'task-a', sessionId: 'sched-1', generation: 11, title: '每日任务' })
    assert.equal(handle.code, 'T01')
    assert.equal(handle.context.kind, 'scheduled')
    assert.equal(handle.context.scopeId, 'task-a')
    let run = host.snapshot().runs.find((item) => item.runId === handle.runId)
    assert.equal(run.kind, 'scheduled')
    assert.equal(run.code, 'T01')
    assert.equal(run.sessionId, 'sched-1')
    assert.equal(run.phase.kind, 'queued', '发送前先登记为 scheduled 排队，不冒充会话运行')
    assert.equal(host.snapshot().runs.filter((item) => item.kind === 'scheduled').length, 1)

    // 2. 发送前的早期信号（标题）不能把会话先分一个 S 号。
    schedObs({ sessionId: 'sched-1', title: '每日任务' }, { type: 'title', title: '每日任务' })
    run = host.snapshot().runs.find((item) => item.runId === handle.runId)
    assert.equal(run.code, 'T01')
    let codeDoc = await readCodes(root)
    assert.ok(
      !codeDoc.entries.some((entry) => entry.scopeId === 'sched-1'),
      '定时会话不得先被分配 S 号'
    )
    assert.deepEqual(
      codeDoc.entries.filter((entry) => entry.scopeId === 'task-a').map((entry) => [entry.kind, entry.code]),
      [['scheduled', 'T01']],
      '任务 id 只持久一条 kind:scheduled 的 T 号'
    )

    // 3. 同一条运行沿正式 RunContext 消费信号：agent-start → running，settled → done。
    now = 2_000
    schedObs({ sessionId: 'sched-1' }, { type: 'agent-start' })
    assert.equal(host.snapshot().runs.find((item) => item.runId === handle.runId).phase.kind, 'running')
    now = 2_500
    host.observeSubagentEvent(
      { id: 'sub-sched', parentSessionId: 'sched-1', task: '定时子任务' },
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta' } }
    )
    const schedChild = host.snapshot().runs.find((item) => item.kind === 'subagent')
    assert.equal(schedChild.code, 'T01·1', '定时会话的子运行沿用父 T 号')
    assert.equal(schedChild.parentRunId, handle.runId)

    // 4. 普通会话与它的子运行编号不受影响。
    const normalObs = host.observerFor({ generation: 12 })
    normalObs({ sessionId: 'normal-1', title: '普通会话' }, { type: 'agent-start' })
    await waitFor(() => host.snapshot().runs.some((item) => item.sessionId === 'normal-1'))
    const normalRun = host.snapshot().runs.find((item) => item.sessionId === 'normal-1')
    assert.equal(normalRun.code, 'S1')
    host.observeSubagentEvent(
      { id: 'sub-normal', parentSessionId: 'normal-1', task: '普通子任务' },
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta' } }
    )
    assert.equal(host.snapshot().runs.find((item) => item.code === 'S1·1').code, 'S1·1')

    now = 3_000
    schedObs({ sessionId: 'sched-1' }, { type: 'agent-settled', aborted: false })
    run = host.snapshot().runs.find((item) => item.runId === handle.runId)
    assert.equal(run.phase.kind, 'done')

    // 5. 终态后迟到事件不复活、也不给会话补 S 号。
    const before = host.snapshot().runs.length
    schedObs({ sessionId: 'sched-1' }, { type: 'tool-end', isWrite: false })
    schedObs({ sessionId: 'sched-1' }, { type: 'agent-start' })
    assert.equal(host.snapshot().runs.length, before, '迟到信号不能重开定时运行')
    assert.equal(host.snapshot().runs.find((item) => item.runId === handle.runId).phase.kind, 'done')
    codeDoc = await readCodes(root)
    assert.ok(!codeDoc.entries.some((entry) => entry.scopeId === 'sched-1'), '迟到事件也不该给定时会话分 S 号')

    // 5b. 只有显式清除来源（被普通选择复用）后才回到会话编号。
    host.clearScheduledOrigin({ sessionId: 'sched-1' })
    schedObs({ sessionId: 'sched-1' }, { type: 'agent-start' })
    await waitFor(() => host.snapshot().runs.some((item) => item.sessionId === 'sched-1' && item.kind === 'session'))
    const resumed = host.snapshot().runs.find((item) => item.sessionId === 'sched-1' && item.kind === 'session')
    assert.equal(resumed.code, 'S2', '清除定时来源后才按普通会话编号')

    // 6. 失败用同一 ctx 收口成 failed。
    const failed = await host.openScheduled({ scopeId: 'task-fail', sessionId: 'sched-2', generation: 13 })
    assert.equal(failed.code, 'T02')
    host.failScheduled(failed, '指令没有发出')
    const failedRun = host.snapshot().runs.find((item) => item.runId === failed.runId)
    assert.equal(failedRun.phase.kind, 'failed')
    assert.equal(failedRun.phase.cause, 'host')

    // 7. 同一任务多次运行各自独立：复用同一个 T 号，但 runId / 运行实例分开。
    const again = await host.openScheduled({ scopeId: 'task-a', sessionId: 'sched-3', generation: 14 })
    assert.equal(again.code, 'T01', '同一任务的 T 号稳定')
    assert.notEqual(again.runId, handle.runId, '再次触发是一个独立运行实例')
    const againRun = host.snapshot().runs.find((item) => item.runId === again.runId)
    assert.equal(againRun.phase.kind, 'queued')
    assert.equal(host.snapshot().runs.find((item) => item.runId === handle.runId).phase.kind, 'done', '旧运行状态不被新运行改写')
    host.cancelScheduled(again)
    assert.equal(host.snapshot().runs.find((item) => item.runId === again.runId).phase.kind, 'stopped')

    // 8. 选择期绑定后由第一个事件懒登记：仍走 T 号，不先分 S。
    const lazyObs = host.observerFor({ generation: 15 })
    host.bindScheduledOrigin({ scopeId: 'task-lazy', sessionId: 'sched-lazy' })
    lazyObs({ sessionId: 'sched-lazy', title: '懒登记任务' }, { type: 'agent-start' })
    await waitFor(() => host.snapshot().runs.some((item) => item.sessionId === 'sched-lazy'))
    const lazyRun = host.snapshot().runs.find((item) => item.sessionId === 'sched-lazy')
    assert.equal(lazyRun.kind, 'scheduled')
    assert.equal(lazyRun.code, 'T03')
    codeDoc = await readCodes(root)
    assert.ok(!codeDoc.entries.some((entry) => entry.scopeId === 'sched-lazy'), '懒登记也不给会话分 S')

    // 9. 会话编号列表：任务 id 是 scheduled T，普通会话是 session S。
    const byScope = new Map(codeDoc.entries.map((entry) => [entry.scopeId, entry]))
    assert.equal(byScope.get('task-a').code, 'T01')
    assert.equal(byScope.get('task-a').kind, 'scheduled')
    assert.equal(byScope.get('task-fail').code, 'T02')
    assert.equal(byScope.get('task-lazy').code, 'T03')
    assert.equal(byScope.get('normal-1').code, 'S1')
    assert.equal(byScope.get('normal-1').kind, 'session')

    now = 4_000
    normalObs({ sessionId: 'normal-1' }, { type: 'agent-settled', aborted: false })
    await host.dispose()

    // 11. 重启（同一数据目录）：任务 T 号从持久文件恢复，不重新编号、不串历史。
    const host2 = await hostMod.createRunsHost({ root, push: () => {}, now: () => now, newRunId: () => `run2-${++seq}` })
    const restarted = await host2.openScheduled({ scopeId: 'task-a', sessionId: 'sched-restart' })
    assert.equal(restarted.code, 'T01', '重启后同一任务仍是同一个 T 号')
    assert.equal(restarted.context.kind, 'scheduled')
    host2.cancelScheduled(restarted)
    await host2.dispose()

    // 10. 运行历史按正式 kind / 编号落盘，终态各自独立。
    const history = await readHistory(root)
    const scheduledHistory = history.filter((record) => record.kind === 'scheduled')
    assert.ok(scheduledHistory.some((record) => record.code === 'T01' && record.terminal === 'done'))
    assert.ok(scheduledHistory.some((record) => record.code === 'T02' && record.terminal === 'failed'))
    assert.ok(history.some((record) => record.kind === 'session' && record.code === 'S1'))

    console.log('v3-scheduled-runs: 全部通过')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run()
}
