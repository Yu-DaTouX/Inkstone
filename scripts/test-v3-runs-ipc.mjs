/**
 * v3 运行 IPC 单测（WP-10 / WP-54）。
 *
 * 现场用 esbuild 编译 `src/main/ipc/runs-ipc.ts`（含它 import 的 `paths` /
 * `runs/history` / `shared/runs`），在隔离临时目录里跑，**不启动 Electron、
 * 不起 pi、不写用户数据目录**。可独立执行：
 *
 *   node scripts/test-v3-runs-ipc.mjs
 *
 * 覆盖：
 *   · `yan:runs:history` 的有界读取（行数上限 / 超长行跳过）、坏行跳过不抛、
 *     日期与区间解析、缺文件、筛选、倒序与 limit 截断；
 *   · `yan:runs:stop` 对未知 / 已结束 / 运行中（会话与子 Agent）的分支：
 *     只接受当前登记且仍在运行的运行，会话停止走注入的正式路径（假 controller，
 *     不新造循环），停止后同一 runId 再停即已结束；
 *   · `yan:runs:snapshot` / `yan:runs:markSeen` 经同一注册器转发。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

async function compile(entry, outfile) {
  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  return outfile
}

/** 只实现 registrar 用到的两个方法，把处理器收进 Map。 */
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
    await compile('src/main/ipc/runs-ipc.ts', outfile)
    /* 夹具用临时 YAN_DATA_DIR：模块在导入时读取环境，必须在 import 之前设好。 */
    process.env.YAN_DATA_DIR = dataRoot
    const mod = await import(pathToFileURL(outfile).href)

    await runHistoryTests(mod, dataRoot)
    await runStopTests(mod)
    await runRegistrarTests(mod)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/* ───────────────────────── 运行历史 ───────────────────────── */

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

  /* 单日：坏行 / 空行 / 非对象 / 超长行都跳过，只留 3 条有效记录。 */
  const single = await mod.readRunsHistory({ date: days[0] }, dataRoot)
  assert.equal(single.ok, true)
  assert.deepEqual(single.records.map((r) => r.runId).sort(), ['a', 'b', 'c'])
  assert.deepEqual(single.days, [days[0]])
  assert.equal(single.truncated, false)
  assert.equal(single.records[0].runId, 'c', '按结束时间倒序')

  /* limit 截断并标记 truncated。 */
  const limited = await mod.readRunsHistory({ date: days[0], limit: 2 }, dataRoot)
  assert.equal(limited.records.length, 2)
  assert.equal(limited.truncated, true)

  /* 区间读两天，合并后仍倒序。 */
  const ranged = await mod.readRunsHistory({ range: { from: days[0], to: days[1] } }, dataRoot)
  assert.deepEqual(ranged.days, days)
  assert.deepEqual(ranged.records.map((r) => r.runId), ['d', 'c', 'b', 'a'])
  assert.equal(ranged.truncated, false)

  /* 筛选：终态、类型、会话、模型、标题。 */
  const onlyFailed = await mod.readRunsHistory({ date: days[0], filters: { terminal: ['failed'] } }, dataRoot)
  assert.deepEqual(onlyFailed.records.map((r) => r.runId), ['b'])
  const onlySub = await mod.readRunsHistory({ date: days[0], filters: { kind: ['subagent'] } }, dataRoot)
  assert.deepEqual(onlySub.records.map((r) => r.runId), ['c'])
  const bySession = await mod.readRunsHistory({ date: days[0], filters: { sessionId: 's1' } }, dataRoot)
  assert.equal(bySession.records.length, 3)
  const byTitle = await mod.readRunsHistory({ date: days[0], filters: { query: '构建' } }, dataRoot)
  assert.deepEqual(byTitle.records.map((r) => r.runId), ['b'])

  /* 缺文件不算失败，只是空结果。 */
  const missing = await mod.readRunsHistory({ date: '2025-12-31' }, dataRoot)
  assert.equal(missing.ok, true)
  assert.deepEqual(missing.records, [])

  /* 非法输入如实报错，不抛。 */
  const bad = await mod.readRunsHistory({ date: '2026/01/02' }, dataRoot)
  assert.equal(bad.ok, false)
  assert.match(bad.error, /日期/)
  const both = await mod.readRunsHistory({ date: days[0], range: { from: days[0] } }, dataRoot)
  assert.equal(both.ok, false)
  const tooLong = await mod.readRunsHistory({ range: { from: '2026-01-01', to: '2026-03-01' } }, dataRoot)
  assert.equal(tooLong.ok, false)
  assert.match(tooLong.error, /31/)

  /* 日期解析规则与读取共用。 */
  assert.deepEqual(mod.resolveHistoryDays({ date: '2026-01-02' }).days, ['2026-01-02'])
  assert.deepEqual(mod.resolveHistoryDays({ range: { from: '2026-01-01', to: '2026-01-03' } }).days, [
    '2026-01-01',
    '2026-01-02',
    '2026-01-03'
  ])

  /* 经注册器且不传 root：走缺省 YAN_DIR（这里就是临时 YAN_DATA_DIR 夹具）。 */
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

/* ───────────────────────── 停止运行 ───────────────────────── */

async function runStopTests(mod) {
  const ipc = fakeIpc()
  const calls = { session: [], subagent: [] }
  /* 假 controller：abort() 把运行置为已停止；不碰 pi，也不起模型循环。 */
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

  /* 未知 runId：不命中，不能停任何东西。 */
  const unknown = await ipc.invoke('yan:runs:stop', 'run-missing')
  assert.equal(unknown.ok, false)
  assert.equal(calls.session.length, 0)
  assert.equal(calls.subagent.length, 0)
  /* 空 / 非字符串同样拒绝。 */
  assert.equal((await ipc.invoke('yan:runs:stop', '   ')).ok, false)
  assert.equal((await ipc.invoke('yan:runs:stop', 123)).ok, false)

  /* 已结束的运行：返回 ok:false，且不调 stop。 */
  const done = await ipc.invoke('yan:runs:stop', 'run-done')
  assert.equal(done.ok, false)
  assert.equal(calls.session.length, 0)

  /* 运行中的会话运行：走注入的正式停止路径，且只调一次。 */
  const live = await ipc.invoke('yan:runs:stop', 'run-live')
  assert.deepEqual(live, { ok: true, runId: 'run-live', kind: 'session' })
  assert.equal(calls.session.length, 1)
  assert.equal(calls.session[0].sessionId, 's-live')
  assert.equal(fakeController.aborted, 1)
  assert.equal(calls.subagent.length, 0)

  /* 停过之后同一 runId 已结束：再停返回 ok:false（防止重复停止）。 */
  const again = await ipc.invoke('yan:runs:stop', 'run-live')
  assert.equal(again.ok, false)
  assert.equal(fakeController.aborted, 1)

  /* 子 Agent 运行：复用注入的子代理 stop，不走会话 abort。 */
  const child = await ipc.invoke('yan:runs:stop', 'run-child')
  assert.deepEqual(child, { ok: true, runId: 'run-child', kind: 'subagent' })
  assert.deepEqual(calls.subagent, ['run-child'])
  assert.equal(fakeController.aborted, 1)

  /* 其它类型（定时 / 评审）当前不在这里停，如实返回不支持。 */
  const scheduled = await ipc.invoke('yan:runs:stop', 'run-scheduled')
  assert.equal(scheduled.ok, false)
  assert.equal(scheduled.kind, 'scheduled')

  /* 停止路径失败时如实把错误带回渲染端。 */
  const failing = fakeIpc()
  mod.registerRunsIpc(failing, {
    snapshot: () => ({ revision: 0, runs: [runSnapshot('run-x', { kind: 'running', since: 0, activity: 'streaming' })] }),
    markSeen: () => ({ ok: false }),
    stopSessionRun: async () => ({ ok: false, error: '实例已退出' }),
    stopSubagentRun: async () => ({ ok: false })
  })
  const failed = await failing.invoke('yan:runs:stop', 'run-x')
  assert.deepEqual(failed, { ok: false, error: '实例已退出', runId: 'run-x' })

  /*
   * 停止会话运行拿回的 clear_queue 排队文本必须原样透传给渲染端（不能在这里丢）。
   * 交接取消逻辑在 src/main/index.ts 的 `stopRunnerWithHandoff` 里，随 Electron
   * 入口一起加载；本脚本只 bundle runs-ipc，因此不在这里覆盖（见交付说明未验证项）。
   */
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

/* ─────────────────────── registrar 迁移 ─────────────────────── */

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
  /* 非字符串不写进 markSeen（防越权 / 防脏 key）。 */
  await ipc.invoke('yan:runs:markSeen', 42)
  assert.deepEqual(marked, ['r1', ''])
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runV3RunsIpcTests()
  console.log('v3-runs-ipc: 全部通过')
}
