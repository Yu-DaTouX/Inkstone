import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

async function compile(entry, outfile) {
  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  return import(pathToFileURL(outfile).href)
}

function codes(seed = {}) {
  const map = new Map(Object.entries(seed))
  return { codeFor: (id) => map.get(id), set: (id, code) => map.set(id, code) }
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 5))
}

export async function runRunsRegistryTests() {
  const dir = await mkdtemp(join(tmpdir(), 'inkstone-runs-registry-'))
  try {
    const { RunRegistry, DurableRunHistory, MemoryRunHistory } = await compile('src/main/runs/index.ts', join(dir, 'runs.mjs'))

    {
      const errors = []
      const bare = new RunRegistry({ now: () => 1000, onError: (error) => errors.push(error) })
      assert.equal(bare.open({ sessionId: 's1' }), null)
      assert.equal(errors.length, 1)
      assert.equal(errors[0].code, 'code-unavailable')
      assert.equal(errors[0].sessionId, 's1')
      assert.equal(bare.size(), 0)
      assert.equal(bare.observe({ sessionId: 's1' }, { type: 'agent-start' }), null, '开跑信号同样拿不到编号')
      assert.equal(errors.length, 2)
      assert.equal(bare.observe({ sessionId: 's1' }, { type: 'activity', activity: 'thinking' }), null, '没有活动实例时不凭空建运行')
      assert.equal(errors.length, 2, '非开跑信号不报编号错误')
    }

    {
      const store = codes({ s1: 'S1' })
      const changes = []
      let auto = 0
      let clock = 1000
      const registry = new RunRegistry({ codes: store, now: () => clock, newRunId: () => `auto-${++auto}`, onChange: (change) => changes.push(change) })
      const snapshot = registry.open({ sessionId: 's1', runId: 'r1', title: '会话一', model: { provider: 'p', id: 'm', label: 'M' }, sessionPath: '/tmp/a', projectId: 'proj' })
      assert.equal(snapshot.runId, 'r1')
      assert.equal(snapshot.code, 'S1')
      assert.equal(snapshot.kind, 'session')
      assert.equal(snapshot.title, '会话一')
      assert.deepEqual(snapshot.model, { provider: 'p', id: 'm', label: 'M' })
      assert.equal(snapshot.sessionPath, '/tmp/a')
      assert.equal(snapshot.projectId, 'proj')
      assert.equal(snapshot.phase.kind, 'running')
      assert.equal(snapshot.phase.activity, 'waiting-model')
      assert.equal(snapshot.startedAt, 1000)
      assert.deepEqual(snapshot.counts, { tools: 0, edits: 0, errors: 0 })
      assert.equal(registry.size(), 1)
      assert.equal(changes.length, 1)
      assert.equal(changes[0].immediate, false, 'running 不是立即推送阶段')
      assert.equal(changes[0].runs[0].runId, 'r1')

      store.set('s2', 'S2')
      const auto1 = registry.open({ sessionId: 's2' })
      assert.equal(auto1.runId, 'auto-1', '未给 runId 时用注入的生成器')
      assert.equal(auto1.code, 'S2')
    }

    {
      let clock = 1000
      const registry = new RunRegistry({ codes: codes({ s1: 'S1' }), now: () => clock })
      let snapshot = registry.observe({ sessionId: 's1' }, { type: 'queued', reason: 'concurrency', at: 5000 })
      assert.equal(snapshot.phase.kind, 'queued')
      assert.equal(snapshot.phase.reason, 'concurrency')
      assert.equal(snapshot.phase.at, 5000)
      const runId = snapshot.runId
      const since = snapshot.phase.since
      clock = 1100
      const queuedAgain = registry.observe({ sessionId: 's1' }, { type: 'queued', reason: 'followup' })
      assert.equal(queuedAgain.runId, runId)
      assert.equal(queuedAgain.phase.since, since, '排队起点保持不变')
      assert.equal(queuedAgain.phase.at, 5000, '未给 at 时保留原定时间')
      snapshot = registry.observe({ sessionId: 's1' }, { type: 'agent-start' })
      assert.equal(snapshot.runId, runId)
      assert.equal(snapshot.phase.kind, 'running')
      assert.equal(registry.observe({ sessionId: 's1' }, { type: 'seen' }), null, 'running 下 seen 不产生变化')
      assert.equal(registry.observe({ sessionId: 's1', runId: 'missing' }, { type: 'activity', activity: 'thinking' }), null)
    }

    {
      let clock = 1000
      const registry = new RunRegistry({ codes: codes({ s1: 'S1' }), now: () => clock })
      registry.open({ sessionId: 's1', runId: 'r1' })
      assert.equal(registry.observe({ sessionId: 's1', runId: 'ghost' }, { type: 'activity', activity: 'thinking' }), null)
      const terminal = registry.observe({ sessionId: 's1' }, { type: 'agent-settled', aborted: false })
      assert.equal(terminal.phase.kind, 'done')
      assert.equal(registry.observe({ sessionId: 's1' }, { type: 'activity', activity: 'streaming' }), null, '终态实例不再接受新信号')
      assert.equal(registry.observe({ sessionId: 's1', runId: 'r1' }, { type: 'tool-update' }), null)
      assert.equal(registry.markSeen('r1').phase.seen, true)
      assert.equal(registry.markSeen('r1'), null, '已读不重复改动')
      assert.equal(registry.markSeen('missing'), null)
      const running = registry.open({ sessionId: 's1', runId: 'r2' })
      assert.equal(running.phase.kind, 'running')
      assert.equal(registry.markSeen('r2'), null, 'running 不接受已读')
    }

    {
      let clock = 1000
      const changes = []
      const registry = new RunRegistry({ codes: codes({ s1: 'S1' }), now: () => clock, onChange: (change) => changes.push(change) })
      registry.open({ sessionId: 's1', runId: 'm1', title: '旧标题' })
      changes.length = 0
      clock = 1100
      const merged = registry.observe({ sessionId: 's1', title: '新标题', model: { provider: 'p', id: 'm2', label: 'M2' } }, { type: 'activity', activity: 'thinking' })
      assert.equal(merged.title, '新标题')
      assert.equal(merged.model.id, 'm2')
      assert.equal(changes.length, 1)
      assert.equal(changes[0].runs[0].title, '新标题')

      changes.length = 0
      clock = 1200
      const metaOnly = registry.observe({ sessionId: 's1', title: '最终标题' }, { type: 'seen' })
      assert.ok(metaOnly)
      assert.equal(metaOnly.title, '最终标题')
      assert.equal(changes.length, 1, '仅元数据变化也要推送')
      assert.equal(changes[0].runs[0].title, '最终标题')
      assert.equal(registry.observe({ sessionId: 's1', title: '最终标题' }, { type: 'seen' }), null, '元数据无变化且信号无变化时返回 null')
    }

    {
      let clock = 1000
      const changes = []
      const registry = new RunRegistry({ codes: codes({ s1: 'S1' }), now: () => clock, onChange: (change) => changes.push(change) })
      registry.open({ sessionId: 's1', runId: 'r1' })
      changes.length = 0
      const needs = registry.observe({ sessionId: 's1' }, { type: 'needs-you', request: { id: 'q1', type: 'danger', summary: '删库' } })
      assert.equal(needs.phase.kind, 'needs-you')
      assert.equal(needs.phase.request.id, 'q1')
      assert.equal(changes.at(-1).immediate, true, 'needs-you 立即推送')
      clock = 1100
      registry.observeUiResolved({ sessionId: 's1' }, 'q1')
      assert.equal(registry.get('r1').phase.kind, 'running')
      assert.equal(changes.at(-1).immediate, false, '恢复 running 走合并窗口')

      assert.equal(registry.observeUiRequest({ sessionId: 's1' }, { id: 'q2', method: 'confirm', title: '继续?' }).phase.request.type, 'confirm')
      registry.observeUiResolved({ sessionId: 's1' }, 'q2')
      assert.equal(registry.observeUiRequest({ sessionId: 's1' }, { id: 'q3', method: 'notify', title: '忽略' }), null, '非交互方法不登记')
      assert.equal(registry.observeDangerConfirmation({ sessionId: 's1' }, { id: 'd1', summary: 'git push --force' }).phase.request.type, 'danger')
      registry.observeUiResolved({ sessionId: 's1' }, 'd1')
      assert.equal(registry.stop({ sessionId: 's1' }).phase.kind, 'stopped')
      assert.equal(registry.get('r1').phase.by, 'user')
    }

    {
      let clock = 1000
      const registry = new RunRegistry({ codes: codes({ s1: 'S1' }), now: () => clock })
      registry.open({ sessionId: 's1', runId: 'r1' })
      const loop = registry.markLoopAbort({ sessionId: 's1' }, '重复输出')
      assert.equal(loop.phase.kind, 'stalled')
      assert.equal(loop.phase.cause, 'loop')
      assert.equal(loop.phase.detail, '重复输出')
      const aborted = registry.observe({ sessionId: 's1' }, { type: 'agent-settled', aborted: true })
      assert.equal(aborted.phase.kind, 'stalled')
      assert.equal(aborted.phase.cause, 'loop')

      const exit = registry.observePiExit({ sessionId: 's1' }, 1, null)
      assert.equal(exit.phase.kind, 'failed')
      assert.equal(exit.phase.cause, 'pi-exit')
      assert.match(exit.phase.message, /code=1/)
      const stopped = registry.stop({ sessionId: 's1' }, 'host')
      assert.equal(stopped, null, '终态之后 stop 不再改动')
      assert.equal(registry.get('r1').phase.cause, 'pi-exit')
    }

    {
      let clock = 1000
      const registry = new RunRegistry({ codes: codes({ s1: 'S1' }), now: () => clock })
      registry.open({ sessionId: 's1', generation: 2, runId: 'g1' })
      assert.equal(registry.observe({ sessionId: 's1', generation: 1 }, { type: 'activity', activity: 'thinking' }), null, '旧 generation 事件必须丢弃')
      assert.ok(registry.observe({ sessionId: 's1', generation: 3, runId: 'g1' }, { type: 'activity', activity: 'thinking' }))
      assert.ok(registry.observe({ sessionId: 's1', generation: 3 }, { type: 'activity', activity: 'streaming' }))
      assert.ok(registry.observe({ sessionId: 's1' }, { type: 'activity', activity: 'thinking' }), '未声明 generation 的事件仍然接受')

      const late = new RunRegistry({ codes: codes({ s2: 'S2' }), now: () => clock })
      late.open({ sessionId: 's2', runId: 'l1' })
      const accepted = late.observe({ sessionId: 's2', generation: 5 }, { type: 'activity', activity: 'thinking' })
      assert.ok(accepted)
      assert.equal(late.observe({ sessionId: 's2', generation: 4 }, { type: 'activity', activity: 'streaming' }), null, '首次声明 generation 后按它过滤旧事件')
    }

    {
      let clock = 1000
      const changes = []
      const registry = new RunRegistry({ codes: codes({ s1: 'S1' }), now: () => clock, onChange: (change) => changes.push(change) })
      registry.open({ sessionId: 's1', runId: 'r1' })
      changes.length = 0
      clock = 1100
      const reopened = registry.open({ sessionId: 's1', runId: 'r1' }, { kind: 'queued', since: 1100, reason: 'followup' })
      assert.equal(reopened.phase.kind, 'queued')
      assert.equal(changes.length, 1)
      assert.equal(changes[0].immediate, false)
      assert.equal(changes[0].runs[0].phase.kind, 'queued')

      clock = 1200
      const superseded = registry.open({ sessionId: 's1', runId: 'r2' })
      assert.equal(superseded.phase.kind, 'running')
      assert.equal(registry.get('r1').phase.kind, 'stopped')
      assert.equal(registry.get('r1').phase.by, 'host', '同会话新运行会顶掉旧的')
    }

    {
      const records = []
      const history = { append: async (record) => { records.push(record) } }
      let clock = 1000
      const registry = new RunRegistry({ codes: codes({ s1: 'S1' }), history, now: () => clock })
      registry.open({ sessionId: 's1', runId: 'h1', title: '带历史', sessionPath: '/tmp/h', projectId: 'proj' })
      clock = 1100
      registry.observe({ sessionId: 's1' }, { type: 'needs-you', request: { id: 'q1', type: 'confirm', summary: '确认' } })
      clock = 1200
      registry.observe({ sessionId: 's1' }, { type: 'request-answered', requestId: 'q1' })
      clock = 1300
      registry.observePi({ sessionId: 's1' }, { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'edit', args: { path: 'src/a.ts' } })
      registry.observe({ sessionId: 's1' }, { type: 'cost', usd: 0.25 })
      clock = 1400
      registry.observePi({ sessionId: 's1' }, { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'edit', isError: false })
      clock = 1500
      registry.observePi({ sessionId: 's1' }, { type: 'agent_settled', aborted: false })
      await registry.whenIdle()
      assert.equal(records.length, 1)
      const record = records[0]
      assert.equal(record.runId, 'h1')
      assert.equal(record.code, 'S1')
      assert.equal(record.terminal, 'done')
      assert.equal(record.startedAt, 1000)
      assert.equal(record.endedAt, 1500)
      assert.equal(record.sessionPath, '/tmp/h')
      assert.equal(record.projectId, 'proj')
      assert.equal(record.costUsd, 0.25)
      assert.deepEqual(record.counts, { tools: 1, edits: 1, errors: 0 })
      assert.deepEqual(record.segments, [
        { phase: 'running', from: 1000, to: 1100 },
        { phase: 'needs-you', from: 1100, to: 1200 },
        { phase: 'running', from: 1200, to: 1500 }
      ])
      assert.equal(registry.observe({ sessionId: 's1' }, { type: 'activity', activity: 'thinking' }), null)
      assert.equal(records.length, 1, '终态只写一条历史')
    }

    {
      const records = []
      const history = { append: async (record) => { records.push(record) } }
      let clock = 1000
      const registry = new RunRegistry({ codes: codes({ s1: 'S1', s2: 'S2' }), history, now: () => clock })
      registry.open({ sessionId: 's1', runId: 'f1' })
      clock = 1100
      registry.observePiExit({ sessionId: 's1' }, null, 'SIGKILL')
      assert.equal(records[0].terminal, 'failed')
      assert.equal(records[0].cause, 'pi-exit')
      assert.match(records[0].message, /code=null/)

      registry.open({ sessionId: 's2', runId: 'f2' })
      clock = 1200
      registry.stop({ sessionId: 's2' }, 'host')
      assert.equal(records[1].terminal, 'stopped')
      assert.equal(records[1].cause, 'host')
    }

    {
      const errors = []
      const history = { append: async () => { throw new Error('disk full') } }
      let clock = 1000
      const registry = new RunRegistry({ codes: codes({ s1: 'S1' }), history, now: () => clock, onError: (error) => errors.push(error) })
      registry.open({ sessionId: 's1', runId: 'e1' })
      registry.observe({ sessionId: 's1' }, { type: 'agent-settled', aborted: false })
      await tick()
      assert.equal(errors.length, 1)
      assert.equal(errors[0].code, 'history-write-failed')
      assert.equal(errors[0].runId, 'e1')
      assert.match(errors[0].message, /disk full/)
    }

    {
      let clock = 1000
      const registry = new RunRegistry({ codes: codes({ a: 'S-a', b: 'S-b', c: 'S-c', d: 'S-d', e: 'S-e', f: 'S-f', g: 'S-g' }), now: () => clock })
      registry.observe({ sessionId: 'a' }, { type: 'queued', reason: 'followup' })
      registry.open({ sessionId: 'b' })
      registry.open({ sessionId: 'c' })
      registry.observe({ sessionId: 'c' }, { type: 'needs-you', request: { id: 'q', type: 'confirm', summary: 's' } })
      registry.open({ sessionId: 'd' })
      registry.observe({ sessionId: 'd' }, { type: 'loop-abort' })
      registry.open({ sessionId: 'e' })
      registry.observe({ sessionId: 'e' }, { type: 'pi-exit', code: 1 })
      registry.open({ sessionId: 'f' })
      registry.observe({ sessionId: 'f' }, { type: 'agent-settled', aborted: false })
      registry.open({ sessionId: 'g' })
      registry.observe({ sessionId: 'g' }, { type: 'stopped', by: 'user' })
      assert.deepEqual(registry.list().map((run) => run.phase.kind), ['needs-you', 'stalled', 'failed', 'running', 'queued', 'done', 'stopped'])
      assert.deepEqual(new Set(registry.runningStates().map((state) => state.sessionId)), new Set(['a', 'b', 'c', 'd']))
      assert.equal(registry.size(), 7)
      assert.equal(registry.get('missing'), undefined)
    }

    {
      let clock = 1000
      const registry = new RunRegistry({ codes: codes({ first: 'S1', second: 'S2' }), now: () => clock })
      const events = []
      const unsubscribe = registry.subscribe((change) => events.push(change))
      registry.open({ sessionId: 'first' })
      clock = 2000
      registry.open({ sessionId: 'second' })
      assert.equal(events.length, 2)
      unsubscribe()
      clock = 3000
      registry.observe({ sessionId: 'first' }, { type: 'activity', activity: 'thinking' })
      assert.equal(events.length, 2, '退订后不再收到变化')
    }

    {
      let clock = 1000
      const waiting = []
      const history = new DurableRunHistory(join(dir, 'idle'), {
        write: async (path, text) => {
          await new Promise((resolve) => setTimeout(resolve, 10))
          waiting.push(path)
        }
      })
      const registry = new RunRegistry({ codes: codes({ s1: 'S1' }), history, now: () => clock })
      registry.open({ sessionId: 's1', runId: 'i1' })
      registry.observe({ sessionId: 's1' }, { type: 'agent-settled', aborted: false })
      assert.equal(waiting.length, 0, '写盘是异步的')
      await registry.whenIdle()
      assert.equal(waiting.length, 1)
      assert.match(waiting[0], /runs/)
    }

    {
      let clock = 1000
      const changes = []
      const registry = new RunRegistry({ codes: codes({ s1: 'S1', s4: 'S4' }), now: () => clock, onChange: (change) => changes.push(change) })
      const parent = registry.open({ sessionId: 's4', runId: 'p1' })
      const child1 = registry.open({ sessionId: 'subagent:1', kind: 'subagent', parentRunId: 'p1', runId: 'c1' })
      assert.equal(child1.code, 'S4·1')
      assert.equal(child1.parentRunId, 'p1')
      const child2 = registry.open({ sessionId: 'subagent:2', kind: 'subagent', parentRunId: 'p1', runId: 'c2' })
      assert.equal(child2.code, 'S4·2')
      const child3 = registry.open({ sessionId: 'subagent:3', kind: 'subagent', parentSessionId: 's4', runId: 'c3' })
      assert.equal(child3.code, 'S4·3', '父运行不在时按父会话编号续号')
      assert.equal(child3.parentRunId, undefined)
      const explicit = registry.open({ sessionId: 'subagent:4', kind: 'subagent', parentRunId: 'p1', runId: 'c4', code: 'X9' })
      assert.equal(explicit.code, 'X9')
      const scoped = registry.open({ sessionId: 's5', scopeId: 's4', runId: 'sc' })
      assert.equal(scoped.code, 'S4', 'scopeId 优先于 sessionId 取编号')

      const errors = []
      const noParent = new RunRegistry({ codes: codes({}), now: () => clock, onError: (error) => errors.push(error) })
      assert.equal(noParent.open({ sessionId: 'subagent:9', kind: 'subagent', runId: 'c9' }), null)
      assert.equal(errors.at(-1).code, 'code-unavailable')
      assert.equal(noParent.open({ sessionId: 's9', kind: 'subagent', parentSessionId: 'unknown', runId: 'c10' }), null, '父会话没有编号时也不登记')
    }

    {
      let clock = 1000
      const changes = []
      const registry = new RunRegistry({ codes: codes({ s1: 'S1' }), now: () => clock, onChange: (change) => changes.push(change) })
      assert.equal(registry.open({ sessionId: 's1', runId: 'x1' }).phase.kind, 'running')
      const pi = registry.observePi({ sessionId: 's1' }, { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'edit', args: { path: 'src/a.ts' } })
      assert.equal(pi.length, 1)
      assert.equal(pi[0].phase.activity, 'tool')
      const mapped = registry.observePi({ sessionId: 's1' }, { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta' } })
      assert.equal(mapped[0].phase.activity, 'thinking')
      assert.deepEqual(registry.observePi({ sessionId: 's1' }, { type: 'unknown_event' }), [])
      registry.dispose()
      assert.equal(registry.open({ sessionId: 's1', runId: 'x2' }), null)
      assert.equal(registry.observe({ sessionId: 's1' }, { type: 'agent-start' }), null)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runRunsRegistryTests()
  console.log('runs-registry: 全部通过')
}
