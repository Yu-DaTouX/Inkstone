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

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('waitFor 超时')
}

function messageEvent(kind) {
  return { type: 'message_update', assistantMessageEvent: { type: kind } }
}

async function run() {
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run()
}
