/**
 * v3 运行状态同步纯逻辑单测（WP-11–14）。
 *
 * 现场编译 `src/renderer/src/state/runs-v3.ts`（reducer / 合并 / 排序 / 文案 +
 * zustand 存储 + `startRunSync`），不启动 Electron、不碰 pi、不写用户目录。
 *
 *   node scripts/test-v3-run-sync.mjs
 *
 * 覆盖：增量合并与旧修订丢弃、快照竞态（旧 running 不覆盖新 done）、
 * 快照失败可见错误、提醒条筛选 / 去重 / 上限、状态色与文案，以及
 * `startRunSync` 的订阅先于快照、引用计数幂等、清理。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

function snapshot(runId, phase, extra = {}) {
  return {
    runId,
    code: extra.code ?? runId.toUpperCase(),
    kind: extra.kind ?? 'session',
    sessionId: extra.sessionId ?? `sess-${runId}`,
    title: extra.title ?? '',
    startedAt: extra.startedAt ?? 1000,
    phase,
    counts: extra.counts ?? { tools: 0, edits: 0, errors: 0 },
    ...(extra.sessionPath ? { sessionPath: extra.sessionPath } : {}),
    ...(extra.model ? { model: extra.model } : {}),
    ...(extra.context ? { context: extra.context } : {}),
    ...(extra.costUsd !== undefined ? { costUsd: extra.costUsd } : {})
  }
}

/** 只给本测试用的假 `window`：记录订阅/快照调用顺序，可注入失败。 */
function installFakeWindow({ snapshotImpl, markSeenImpl } = {}) {
  const events = []
  let pushCallback = null
  let unsubscribes = 0
  const win = {
    setTimeout: (...args) => setTimeout(...args),
    clearTimeout: (...args) => clearTimeout(...args),
    yan: {
      onPush: (cb) => {
        events.push('subscribe')
        pushCallback = cb
        return () => {
          unsubscribes += 1
        }
      },
      runs: {
        snapshot: async () => {
          events.push('snapshot-call')
          if (snapshotImpl) return snapshotImpl()
          return { revision: 0, runs: [] }
        },
        markSeen: async (runId) => {
          if (markSeenImpl) return markSeenImpl(runId)
          return { ok: true }
        }
      }
    }
  }
  const previous = globalThis.window
  globalThis.window = win
  return {
    events,
    getPushCallback: () => pushCallback,
    getUnsubscribes: () => unsubscribes,
    restore: () => {
      if (previous === undefined) delete globalThis.window
      else globalThis.window = previous
    }
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'inkstone-v3-run-sync-'))
  let mod
  try {
    const outfile = join(dir, 'runs-v3.mjs')
    await build({
      entryPoints: ['src/renderer/src/state/runs-v3.ts'],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent'
    })
    mod = await import(pathToFileURL(outfile).href)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }

  const {
    initialRunsV3State,
    mergeRunUpdates,
    runsV3Reducer,
    markSeenInRuns,
    attentionPills,
    runTone,
    sortRuns,
    phaseWord,
    phaseDetail,
    toolSummary,
    modelLabel,
    contextPercent,
    runTimeText,
    isUnreadRun,
    isStickyRun,
    useRunsV3,
    startRunSync
  } = mod

  /* ── 1. 合并：新增 / 覆盖 / 移除，并保持 compareRuns 顺序 ── */
  {
    const a = snapshot('a', { kind: 'running', since: 1, activity: 'thinking' }, { startedAt: 5 })
    const b = snapshot('b', { kind: 'needs-you', since: 2, request: { id: 'q1', type: 'confirm', summary: 'sure?' } })
    const merged = mergeRunUpdates([a], { upsert: [b], remove: [] })
    assert.deepEqual(merged.map((r) => r.runId), ['b', 'a'], '等你确认排在运行中之前')

    const updated = mergeRunUpdates(merged, {
      upsert: [snapshot('a', { kind: 'failed', at: 9, cause: 'model-error', message: 'boom', seen: false })],
      remove: []
    })
    assert.equal(updated.length, 2)
    assert.equal(updated[0].runId, 'b', '等你确认（优先级 0）仍在前')
    assert.equal(updated.find((r) => r.runId === 'a').phase.kind, 'failed', '同 runId 被新失败快照覆盖')

    const removed = mergeRunUpdates(updated, { upsert: [], remove: ['b'] })
    assert.deepEqual(removed.map((r) => r.runId), ['a'])
  }

  /* ── 2. 旧修订被丢弃 ── */
  {
    const run = snapshot('a', { kind: 'done', at: 50, seen: false })
    const base = { ...initialRunsV3State, revision: 5, runs: [run] }
    const stale = runsV3Reducer(base, { type: 'push', push: { revision: 5, upsert: [snapshot('a', { kind: 'running', since: 1, activity: 'streaming' })], remove: [] } })
    assert.equal(stale, base, '相同修订号不改变状态')
    assert.equal(stale.runs[0].phase.kind, 'done')

    const older = runsV3Reducer(base, { type: 'push', push: { revision: 3, upsert: [snapshot('a', { kind: 'running', since: 1, activity: 'streaming' })], remove: [] } })
    assert.equal(older.runs[0].phase.kind, 'done', '更旧的增量不能把完成翻回运行中')
  }

  /* ── 3. 快照竞态：快照期间的增量在落地后回放，且只回放更新的修订 ── */
  {
    let state = initialRunsV3State
    state = runsV3Reducer(state, {
      type: 'push',
      push: { revision: 1, upsert: [snapshot('a', { kind: 'running', since: 1, activity: 'thinking' })], remove: [] }
    })
    state = runsV3Reducer(state, { type: 'snapshot-start' })
    assert.equal(state.syncing, true)

    /* 快照请求在途：新完成事件先缓冲，不直接改列表 */
    state = runsV3Reducer(state, {
      type: 'push',
      push: { revision: 2, upsert: [snapshot('a', { kind: 'done', at: 30, seen: false })], remove: [] }
    })
    assert.equal(state.buffer.length, 1)
    assert.equal(state.runs[0].phase.kind, 'running', '缓冲期间列表保持原样')

    /* 慢快照回来，带的是旧的 running（revision 1）；回放 rev2 的 done 获胜 */
    state = runsV3Reducer(state, {
      type: 'snapshot',
      revision: 1,
      runs: [snapshot('a', { kind: 'running', since: 1, activity: 'thinking' })]
    })
    assert.equal(state.syncing, false)
    assert.equal(state.buffer.length, 0)
    assert.equal(state.revision, 2)
    assert.equal(state.runs[0].phase.kind, 'done', '新 done 不被快照里的旧 running 覆盖')
  }

  /* ── 3b. 快照修订比缓冲更新时不回放旧增量 ── */
  {
    let state = runsV3Reducer(initialRunsV3State, { type: 'snapshot-start' })
    state = runsV3Reducer(state, {
      type: 'push',
      push: { revision: 2, upsert: [snapshot('a', { kind: 'done', at: 30, seen: false })], remove: [] }
    })
    state = runsV3Reducer(state, {
      type: 'snapshot',
      revision: 5,
      runs: [snapshot('a', { kind: 'running', since: 1, activity: 'thinking' })]
    })
    assert.equal(state.revision, 5)
    assert.equal(state.runs[0].phase.kind, 'running', '快照更新则忽略缓冲里的旧 done')
  }

  /* ── 4. 快照失败：保留已有数据 + 可见错误，不变回伪空闲 ── */
  {
    let state = runsV3Reducer(initialRunsV3State, {
      type: 'push',
      push: { revision: 4, upsert: [snapshot('a', { kind: 'stalled', since: 1, cause: 'no-output' })], remove: [] }
    })
    state = runsV3Reducer(state, { type: 'snapshot-start' })
    state = runsV3Reducer(state, { type: 'snapshot-error', message: 'ECONNREFUSED' })
    assert.equal(state.error, 'ECONNREFUSED')
    assert.equal(state.syncing, false)
    assert.equal(state.runs.length, 1, '失败不清空已有列表')
    assert.equal(state.runs[0].phase.kind, 'stalled')

    /* 之后的增量仍能应用，且 revision 继续前进 */
    state = runsV3Reducer(state, {
      type: 'push',
      push: { revision: 5, upsert: [snapshot('a', { kind: 'running', since: 6, activity: 'tool', tool: { name: 'bash', label: 'bash', callId: 'c1' } })], remove: [] }
    })
    assert.equal(state.runs[0].phase.kind, 'running')
  }

  /* ── 5. 已读翻转 ── */
  {
    const done = snapshot('a', { kind: 'done', at: 30, seen: false })
    const failed = snapshot('b', { kind: 'failed', at: 30, cause: 'host', message: 'x', seen: false })
    const running = snapshot('c', { kind: 'running', since: 1, activity: 'thinking' })
    const next = markSeenInRuns([done, failed, running], 'a')
    assert.equal(next.find((r) => r.runId === 'a').phase.seen, true)
    assert.equal(isUnreadRun(next.find((r) => r.runId === 'a')), false)
    assert.equal(next.find((r) => r.runId === 'b').phase.seen, false)
    const arr = [running]
    assert.equal(markSeenInRuns(arr, 'c'), arr, '运行中已读不产生新引用')
  }

  /* ── 6. 提醒条筛选：过滤可见会话、同会话一条、上限 2、待审批不可关 ── */
  {
    const runs = [
      snapshot('n1', { kind: 'needs-you', since: 5, request: { id: 'q1', type: 'confirm', summary: 'a' } }, { sessionId: 's1' }),
      snapshot('n2', { kind: 'needs-you', since: 4, request: { id: 'q2', type: 'danger', summary: 'b' } }, { sessionId: 's2' }),
      snapshot('st1', { kind: 'stalled', since: 3, cause: 'retry', retry: { attempt: 1, max: 3 } }, { sessionId: 's3' }),
      snapshot('f1', { kind: 'failed', at: 2, cause: 'host', message: 'x', seen: false }, { sessionId: 's4' }),
      snapshot('r1', { kind: 'running', since: 1, activity: 'thinking' }, { sessionId: 's5' })
    ]
    assert.deepEqual(sortRuns(runs).map((r) => r.runId), ['n2', 'n1', 'st1', 'f1', 'r1'], '同优先级先等得久的在前')

    const visible = { sessionId: 's1' }
    const pills = attentionPills(runs, visible, 2)
    assert.deepEqual(pills.map((r) => r.runId), ['n2', 'st1'], '过滤可见会话、最多两条、按优先级')
    assert.equal(isStickyRun(pills[0]), true, '等你确认不可关闭')

    /* 同一会话最多一条 */
    const duplicated = [
      snapshot('x1', { kind: 'needs-you', since: 9, request: { id: 'q', type: 'confirm', summary: 'x' } }, { sessionId: 'dup' }),
      snapshot('x2', { kind: 'stalled', since: 8, cause: 'no-output' }, { sessionId: 'dup' })
    ]
    assert.deepEqual(attentionPills(duplicated, {}, 2).map((r) => r.runId), ['x1'])
  }

  /* ── 7. 语义色与真实字段文案 ── */
  {
    assert.equal(runTone({ kind: 'running', since: 1, activity: 'thinking' }), 'run')
    assert.equal(runTone({ kind: 'queued', since: 1, reason: 'followup' }), 'run')
    assert.equal(runTone({ kind: 'needs-you', since: 1, request: { id: 'q', type: 'confirm', summary: 's' } }), 'ask')
    assert.equal(runTone({ kind: 'stalled', since: 1, cause: 'retry' }), 'stall')
    assert.equal(runTone({ kind: 'failed', at: 1, cause: 'host', message: 'm', seen: false }), 'fail')
    assert.equal(runTone({ kind: 'done', at: 1, seen: true }), 'done')
    assert.equal(runTone(null), 'idle')

    assert.equal(phaseWord('zh-CN', { kind: 'stalled', since: 1, cause: 'retry' }), '重试中')
    assert.equal(phaseWord('en-US', { kind: 'needs-you', since: 1, request: { id: 'q', type: 'danger', summary: 's' } }), 'Needs you')
    assert.equal(phaseWord('zh-CN', { kind: 'done', at: 1, seen: false }), '已完成')
    assert.equal(phaseDetail('zh-CN', { kind: 'failed', at: 1, cause: 'model-error', message: '上游 502', seen: false }), '上游 502')
    assert.equal(phaseDetail('zh-CN', { kind: 'done', at: 1, seen: true }), null)

    const run = snapshot(
      'a',
      { kind: 'running', since: 1, activity: 'tool', tool: { name: 'edit', label: 'edit', callId: 'c' } },
      { model: { provider: 'p', id: 'm', label: 'm', thinking: 'high' }, counts: { tools: 3, edits: 1, errors: 0 } }
    )
    assert.equal(modelLabel(run), 'm · high')
    assert.equal(toolSummary('zh-CN', run), '工具 3 · 改动 1')
    assert.equal(contextPercent(run), null, '没有 context 就不编百分比')
    assert.equal(contextPercent({ ...run, context: { used: 10, window: 100, percent: 10 } }), 10)
    assert.equal(modelLabel(snapshot('b', { kind: 'done', at: 1, seen: true })), null)
    assert.equal(runTimeText('zh-CN', snapshot('c', { kind: 'done', at: 1000, seen: true }), 61000), '1 分钟前')
  }

  /* ── 8. startRunSync：订阅先于快照、引用计数幂等、清理 ── */
  {
    const fake = installFakeWindow({
      snapshotImpl: () => ({ revision: 7, runs: [snapshot('a', { kind: 'running', since: 1, activity: 'thinking' })] })
    })
    try {
      useRunsV3.setState({ ...initialRunsV3State })
      const off1 = startRunSync()
      const off2 = startRunSync()
      assert.deepEqual(fake.events.slice(0, 2), ['subscribe', 'snapshot-call'], '先订阅再请求快照')

      await flush()
      assert.equal(useRunsV3.getState().revision, 7)
      assert.equal(useRunsV3.getState().runs.length, 1)
      assert.equal(useRunsV3.getState().error, null)

      /* 第二次 startRunSync 不新增订阅 */
      assert.equal(fake.events.filter((e) => e === 'subscribe').length, 1)

      /* 通过订阅回调注入一条增量：修订更大 → 应用 */
      fake.getPushCallback()({ ch: 'runs', payload: { revision: 8, upsert: [snapshot('a', { kind: 'done', at: 40, seen: false })], remove: [] } })
      assert.equal(useRunsV3.getState().revision, 8)
      assert.equal(useRunsV3.getState().runs[0].phase.kind, 'done')

      /* 无关频道被忽略 */
      fake.getPushCallback()({ ch: 'msg-add', payload: {} })
      assert.equal(useRunsV3.getState().revision, 8)

      off1()
      assert.equal(fake.getUnsubscribes(), 0, '还有持有者时不断开')
      off2()
      assert.equal(fake.getUnsubscribes(), 1, '最后一个持有者清理时断开一次')
      off2()
      assert.equal(fake.getUnsubscribes(), 1, '重复调用清理幂等')
    } finally {
      fake.restore()
    }
  }

  /* ── 9. startRunSync 失败：可见错误，不显示伪空闲 ── */
  {
    const fake = installFakeWindow({ snapshotImpl: () => Promise.reject(new Error('bridge down')) })
    try {
      useRunsV3.setState({ ...initialRunsV3State })
      const off = startRunSync()
      await flush()
      assert.equal(useRunsV3.getState().error, 'bridge down')
      assert.equal(useRunsV3.getState().runs.length, 0)
      assert.equal(useRunsV3.getState().syncing, false)
      off()
    } finally {
      fake.restore()
    }
  }

  /* 重试也必须缓冲增量：失败后收到的新完成不能被慢重试的旧快照覆盖。 */
  {
    let attempts = 0
    let retry
    let resolveRetry
    const fake = installFakeWindow({ snapshotImpl: () => {
      attempts += 1
      if (attempts === 1) return Promise.reject(new Error('first attempt failed'))
      return new Promise((resolve) => { resolveRetry = resolve })
    } })
    globalThis.window.setTimeout = (callback) => { retry = callback; return 1 }
    globalThis.window.clearTimeout = () => undefined
    try {
      useRunsV3.setState({ ...initialRunsV3State })
      const off = startRunSync()
      await flush()
      fake.getPushCallback()({ ch: 'runs', payload: {
        revision: 1, upsert: [snapshot('a', { kind: 'running', since: 1, activity: 'thinking' })], remove: []
      } })
      assert.equal(typeof retry, 'function', '失败后计划了重试')
      retry()
      assert.equal(useRunsV3.getState().syncing, true, '重试立即重新开启缓冲')
      fake.getPushCallback()({ ch: 'runs', payload: {
        revision: 2, upsert: [snapshot('a', { kind: 'done', at: 50, seen: false })], remove: []
      } })
      resolveRetry({ revision: 1, runs: [snapshot('a', { kind: 'running', since: 1, activity: 'thinking' })] })
      await flush()
      assert.equal(useRunsV3.getState().runs[0].phase.kind, 'done', '慢重试不能把完成回滚为运行中')
      assert.equal(useRunsV3.getState().revision, 2)
      off()
    } finally {
      fake.restore()
    }
  }

  /* ── 10. 通道缺失：也暴露可见错误 ── */
  {
    const previous = globalThis.window
    globalThis.window = { yan: {}, setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) }
    try {
      useRunsV3.setState({ ...initialRunsV3State })
      const off = startRunSync()
      await flush()
      assert.ok(useRunsV3.getState().error, '没有 runs 通道时给出可见错误')
      off()
    } finally {
      if (previous === undefined) delete globalThis.window
      else globalThis.window = previous
    }
  }

  console.log('v3 运行同步：合并/旧修订/快照竞态/失败可见/提醒条筛选/同步订阅与清理 全部通过')
}

await main()
