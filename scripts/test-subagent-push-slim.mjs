import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { runSuite } from './lib/test-suite.mjs'

const LONG_TASK = '很长的任务说明，逐条列出要查的文件、约束和交付格式。'.repeat(2000)
const BRIEF = { title: '长任务', goal: LONG_TASK, deliverables: ['结论'], sources: [], boundary: '只读' }

function baseRun(overrides = {}) {
  return {
    id: 'sub-aaaaaaaa',
    task: LONG_TASK,
    brief: BRIEF,
    cwd: 'C:/project',
    isolation: 'controlled-cwd',
    status: 'running',
    startedAt: 1,
    review: 'none',
    transcript: [{ id: 'm1', role: 'assistant', text: '开头' }],
    ...overrides
  }
}

function slimOf(run) {
  const { task: _task, brief: _brief, ...rest } = run
  return rest
}

function pushContext(state, calls) {
  return {
    get: () => state,
    set: (patch) => Object.assign(state, patch),
    alertAttention() {},
    pushNotice: (list) => list,
    applyBrowserVisibility() {},
    revealBrowser() {},
    revealTerminal() {},
    resyncSubagents: () => { calls.resync++ },
    t: (key) => key
  }
}

await runSuite(import.meta.url, async (ok, compile) => {
  const { consumeSubagentPush } = await compile('src/renderer/src/state/push-consumers.ts', { packages: 'external' })
  const { applySubagentPatches } = await compile('src/renderer/src/state/subagent-patch-batch.ts')

  {
    const known = baseRun()
    const slimPatch = {
      id: known.id,
      run: slimOf(baseRun({ transcript: [{ id: 'm1', role: 'assistant', text: '续写' }], toolCalls: 3, followUp: '再看一眼' })),
      transcriptFrom: 0,
      textFrom: 2
    }
    const out = applySubagentPatches([known], new Map([[known.id, [slimPatch]]]))
    const merged = out.runs[0]
    ok(!out.stale, '不带任务文本的增量能合并到已有子代理')
    ok(merged.task === LONG_TASK && merged.brief === BRIEF, '合并增量后保留已有的任务文本和 brief')
    ok(merged.transcript[0].text === '开头续写' && merged.toolCalls === 3 && merged.followUp === '再看一眼', '会变的字段照常更新')

    const unknown = applySubagentPatches([], new Map([[known.id, [slimPatch]]]))
    ok(unknown.stale && unknown.runs.length === 0, '没见过的子代理收到增量时重新拉列表，不显示成空任务')
  }

  {
    const known = baseRun()
    const state = { subagents: [known] }
    const calls = { resync: 0 }
    const ctx = pushContext(state, calls)
    consumeSubagentPush({ ch: 'subagent', payload: slimOf(baseRun({ status: 'done', endedAt: 9 })) }, state, ctx)
    ok(state.subagents.length === 1 && state.subagents[0].status === 'done', '不带任务文本的完整推送照常更新状态')
    ok(state.subagents[0].task === LONG_TASK && state.subagents[0].brief === BRIEF, '完整推送不带任务文本时保留已有值')
    ok(calls.resync === 0, '已知子代理不触发重新拉取')

    const fresh = { subagents: [] }
    const freshCalls = { resync: 0 }
    consumeSubagentPush({ ch: 'subagent', payload: slimOf(baseRun()) }, fresh, pushContext(fresh, freshCalls))
    ok(fresh.subagents.length === 0 && freshCalls.resync === 1, '错过第一次推送时不加入空任务，改为重新拉列表')

    const first = { subagents: [] }
    const firstCalls = { resync: 0 }
    consumeSubagentPush({ ch: 'subagent', payload: baseRun({ brief: undefined }) }, first, pushContext(first, firstCalls))
    ok(first.subagents[0]?.task === LONG_TASK && firstCalls.resync === 0, '第一次推送带任务文本时直接加入')
  }

  const { SubagentPushTracker } = await compile('src/shared/subagent-push.ts', { platform: 'neutral' })
  const { SubagentController } = await compile('src/main/subagents.ts')
  const scratch = await mkdtemp(join(tmpdir(), 'inkstone-subagent-push-slim-'))
  const tracker = new SubagentPushTracker()
  const pushes = []
  const raw = { patch: 0, full: 0 }
  const record = (ch, payload) => pushes.push({ ch, payload: JSON.parse(JSON.stringify(payload)), bytes: Buffer.byteLength(JSON.stringify(payload)) })
  let rpc
  const ctrl = new SubagentController({
    cwd: scratch,
    archiveDir: join(scratch, 'archive'),
    prepare: async (rootCwd, _id, isolation) => ({ isolation, rootCwd, cwd: rootCwd }),
    onChange: (run, patch) => {
      raw[patch ? 'patch' : 'full'] += Buffer.byteLength(JSON.stringify(patch ?? run))
      if (patch) record('subagent-patch', tracker.patch(patch))
      else record('subagent', tracker.run(run))
    },
    onPatch: (patch) => {
      raw.patch += Buffer.byteLength(JSON.stringify(patch))
      record('subagent-patch', tracker.patch(patch))
    },
    onRemove: (id) => tracker.forget(id),
    createRpc: () => {
      const handlers = new Map()
      rpc = {
        running: false,
        on(event, fn) { handlers.set(event, fn); return rpc },
        spawn() { rpc.running = true },
        async command(type) { return { success: true, ...(type === 'get_state' ? { data: {} } : {}) } },
        async close() { rpc.running = false },
        emit(evt) { handlers.get('event')?.(evt) }
      }
      return rpc
    }
  })
  const message = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] })
  try {
    const started = await ctrl.start(LONG_TASK, undefined, 'controlled-cwd', { title: '长任务', boundary: '只读' })
    ok(started.ok, '很长的任务文本也能启动子代理', started.error)
    const id = started.run.id
    ctrl.watch([id])
    rpc.emit({ type: 'message_start', message: message('') })
    for (let i = 1; i <= 20; i++) {
      rpc.emit({ type: 'message_update', message: message('进展'.repeat(i)) })
      await new Promise((done) => setTimeout(done, 40))
    }
    rpc.emit({ type: 'tool_execution_start', toolName: 'read' })
    rpc.emit({ type: 'message_end', message: message('进展'.repeat(20)) })
    rpc.emit({ type: 'agent_settled', aborted: false })
    await new Promise((done) => setTimeout(done, 50))

    const own = pushes.filter((p) => (p.ch === 'subagent' ? p.payload.id : p.payload.id) === id)
    const full = own.filter((p) => p.ch === 'subagent')
    const patches = own.filter((p) => p.ch === 'subagent-patch')
    ok(full.length >= 2 && patches.length >= 5, '既有完整推送也有增量推送', `${full.length}/${patches.length}`)
    ok(full[0].payload.task === LONG_TASK && full[0].payload.brief?.goal === LONG_TASK, '第一次推送带完整任务文本和 brief')
    ok(full.slice(1).every((p) => !('task' in p.payload) && !('brief' in p.payload)), '之后的完整推送不带 task 和 brief')
    ok(patches.every((p) => !('task' in p.payload.run) && !('brief' in p.payload.run)), 'subagent-patch 不带 task 和 brief')
    ok(patches.every((p) => p.bytes < LONG_TASK.length), '增量字节不随任务文本长度增长', String(Math.max(...patches.map((p) => p.bytes))))
    const slimBytes = { patch: patches.reduce((n, p) => n + p.bytes, 0), full: full.reduce((n, p) => n + p.bytes, 0) }
    console.log(`  推送字节（任务 ${LONG_TASK.length} 字）：subagent-patch ${patches.length} 次 ${raw.patch} → ${slimBytes.patch}；subagent ${full.length} 次 ${raw.full} → ${slimBytes.full}`)
    ok(slimBytes.patch * 20 < raw.patch, '增量总字节大幅下降')

    let runs = []
    let replayStale = 0
    const calls = { resync: 0 }
    for (const push of own) {
      if (push.ch === 'subagent') {
        const state = { subagents: runs }
        consumeSubagentPush({ ch: 'subagent', payload: push.payload }, state, pushContext(state, calls))
        runs = state.subagents
      } else {
        const out = applySubagentPatches(runs, new Map([[id, [push.payload]]]))
        if (out.stale) replayStale++
        runs = out.runs
      }
    }
    const final = runs.find((run) => run.id === id)
    ok(final?.task === LONG_TASK && final.brief?.goal === LONG_TASK && final.status === 'done', '回放全部推送后任务文本、brief 和最终状态都在')
    ok(calls.resync === 0 && replayStale === 0, '按顺序收到推送时不失配、不需要重新拉列表')

    const resumed = await ctrl.send(id, LONG_TASK, 'steer', { from: 'user' })
    ok(resumed.ok || /会话记录/.test(resumed.error ?? ''), '很长的续派文本不因长度被拒', resumed.error)

    ok(!('task' in tracker.run(started.run)), '移除前再次推送仍不带任务文本')
    tracker.forget(id)
    ok(tracker.run(started.run).task === LONG_TASK, '移除后再次出现会重新带上任务文本')
  } finally {
    await ctrl.stopAll()
    await rm(scratch, { recursive: true, force: true })
  }
}, { isolate: true })
