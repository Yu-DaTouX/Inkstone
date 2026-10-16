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

let step = 0
function ok(label) {
  step += 1
  console.log(`  ok ${step}. ${label}`)
}

const messageEvent = (kind) => ({ type: 'message_update', assistantMessageEvent: { type: kind } })

async function run() {
  const dir = await mkdtemp(join(tmpdir(), 'inkstone-v3-review-runs-'))
  try {
    const hostMod = await compile('src/main/runs-host.ts', join(dir, 'host.mjs'))
    const producerMod = await compile('src/main/review/review-runs.ts', join(dir, 'review-runs.mjs'))

    let now = 1_000
    const host = await hostMod.createRunsHost({
      root: join(dir, 'data'),
      push: () => {},
      now: () => now
    })
    const producer = producerMod.createReviewRunProducer({ registry: host.reviewRunPort(), now: () => now })

    now = 2_000
    assert.equal(
      producer.begin({
        runId: 'sub-normal',
        code: 'R01',
        sessionPath: '/sessions/s1.jsonl',
        projectId: 'p1',
        title: '代码评审 R01',
        model: producerMod.reviewRunModel('p/m', 'high')
      }),
      true
    )
    let review = host.snapshot().runs.find((r) => r.runId === 'sub-normal')
    assert.equal(review.kind, 'review')
    assert.equal(review.code, 'R01')
    assert.equal(review.sessionId, 'review:sub-normal')
    assert.equal(review.sessionPath, '/sessions/s1.jsonl')
    assert.equal(review.projectId, 'p1')
    assert.equal(review.model.label, 'p/m')
    assert.equal(review.model.thinking, 'high')
    assert.equal(review.phase.kind, 'running')
    assert.equal(review.phase.activity, 'waiting-model')
    assert.equal(review.sessionPath, '/sessions/s1.jsonl', '归属会话由 sessionPath 带上')
    ok('评审开始即 open kind:review，编号 / 归属 / 初始阶段正确')

    now = 2_100
    producer.observe('sub-normal', { type: 'agent_start' })
    producer.observe('sub-normal', messageEvent('text_delta'))
    review = host.snapshot().runs.find((r) => r.runId === 'sub-normal')
    assert.equal(review.phase.kind, 'running')
    assert.equal(review.phase.activity, 'streaming')

    now = 2_200
    producer.observe('sub-normal', { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'read', args: { path: 'src/a.ts' } })
    producer.observe('sub-normal', { type: 'tool_execution_update', toolCallId: 'c1' })
    producer.observe('sub-normal', { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'read', isError: false })
    review = host.snapshot().runs.find((r) => r.runId === 'sub-normal')
    assert.equal(review.phase.activity, 'waiting-model')
    assert.equal(review.counts.tools, 1)
    assert.equal(review.counts.edits, 0)
    ok('进度事件按 runId 投影：流式 / 工具计数正确')

    now = 2_300
    producer.observe('sub-normal', { type: 'agent_settled', aborted: false })
    review = host.snapshot().runs.find((r) => r.runId === 'sub-normal')
    assert.equal(review.phase.kind, 'done')
    assert.equal(producer.isActive('sub-normal'), false)
    assert.equal(producer.size(), 0)
    ok('结束收口一次：agent_settled → done，登记表回收')

    const beforeTotal = host.snapshot().runs.length
    now = 2_400
    producer.observe('sub-normal', messageEvent('text_delta'))
    producer.observe('sub-normal', { type: 'tool_execution_start', toolCallId: 'c9', toolName: 'read', args: {} })
    review = host.snapshot().runs.find((r) => r.runId === 'sub-normal')
    assert.equal(review.phase.kind, 'done')
    assert.equal(host.snapshot().runs.length, beforeTotal, '迟到事件不新建运行')
    assert.equal(producer.settle('sub-normal', 'done'), false, '重复收口不生效')
    ok('迟到事件 / 重复收口不覆盖终态，也不新建运行')

    now = 3_000
    assert.equal(producer.begin({ runId: 'sub-fail', code: 'R02', sessionPath: '/sessions/s2.jsonl' }), true)
    producer.observe('sub-fail', messageEvent('text_delta'))
    producer.observe('sub-fail', { type: 'message_end', message: { stopReason: 'error', errorMessage: 'boom' } })
    producer.observe('sub-fail', { type: 'agent_settled', aborted: false })
    review = host.snapshot().runs.find((r) => r.runId === 'sub-fail')
    assert.equal(review.phase.kind, 'failed')
    assert.equal(review.phase.cause, 'model-error')
    assert.equal(producer.isActive('sub-fail'), false)
    ok('失败收口一次：模型错误 → failed')

    now = 4_000
    assert.equal(producer.begin({ runId: 'sub-stop', code: 'R03' }), true)
    producer.observe('sub-stop', messageEvent('thinking_delta'))
    assert.equal(producer.settle('sub-stop', 'stopped'), true)
    review = host.snapshot().runs.find((r) => r.runId === 'sub-stop')
    assert.equal(review.phase.kind, 'stopped')
    assert.equal(producer.isActive('sub-stop'), false)
    assert.equal(producer.settle('sub-stop', 'stopped'), false, '停止只收口一次')
    ok('停止收口一次：stopped，且重复调用幂等')

    now = 5_000
    assert.equal(producer.begin({ runId: 'sub-x', code: 'R04', sessionPath: '/sessions/s3.jsonl' }), true)
    now = 5_100
    assert.equal(producer.begin({ runId: 'sub-y', code: 'R05', sessionPath: '/sessions/s3.jsonl' }), true)
    const x0 = host.snapshot().runs.find((r) => r.runId === 'sub-x')
    const y0 = host.snapshot().runs.find((r) => r.runId === 'sub-y')
    assert.equal(x0.phase.kind, 'running', '开第二个评审不能停掉第一个')
    assert.equal(y0.phase.kind, 'running')
    assert.notEqual(x0.sessionId, y0.sessionId)

    now = 5_200
    producer.observe('sub-x', { type: 'tool_execution_start', toolCallId: 'x1', toolName: 'grep', args: { pattern: 'foo' } })
    producer.observe('sub-y', messageEvent('thinking_delta'))
    const x1 = host.snapshot().runs.find((r) => r.runId === 'sub-x')
    const y1 = host.snapshot().runs.find((r) => r.runId === 'sub-y')
    assert.equal(x1.counts.tools, 1)
    assert.equal(y1.counts.tools, 0, '一个评审的事件不落到另一个评审')
    assert.equal(y1.phase.activity, 'thinking')

    producer.observe('sub-x', { type: 'agent_settled', aborted: false })
    assert.equal(host.snapshot().runs.find((r) => r.runId === 'sub-x').phase.kind, 'done')
    assert.equal(host.snapshot().runs.find((r) => r.runId === 'sub-y').phase.kind, 'running', '一个评审结束不碰另一个')
    producer.settle('sub-y', 'stopped')
    ok('并发两评审：按 runId 隔离，互不覆盖')

    now = 6_000
    host.observerFor()({ sessionId: 'owner-1', title: '主会话' }, { type: 'agent-start' })
    await waitFor(() => host.snapshot().runs.some((r) => r.sessionId === 'owner-1'))
    const sessionRunId = host.snapshot().runs.find((r) => r.sessionId === 'owner-1').runId
    now = 6_100
    assert.equal(producer.begin({ runId: 'sub-owner', code: 'R06', sessionPath: '/sessions/owner-1.jsonl' }), true)
    const sessionRun = host.snapshot().runs.find((r) => r.runId === sessionRunId)
    assert.equal(sessionRun.phase.kind, 'running', '评审运行不能停掉同会话的主会话运行')
    assert.equal(host.snapshot().runs.find((r) => r.runId === 'sub-owner').kind, 'review')
    producer.settle('sub-owner', 'stopped')
    ok('评审运行用独立作用域，不顶掉同会话正在跑的主会话运行')

    const total = host.snapshot().runs.length
    const before = producer.size()
    producer.observe('sub-unknown', messageEvent('text_delta'))
    producer.observe('sub-unknown', { type: 'agent_settled', aborted: false })
    assert.equal(host.snapshot().runs.length, total, '未知 runId 不新建运行')
    assert.equal(producer.size(), before)
    assert.equal(producer.begin({ runId: '', code: 'R07' }), false, '空 runId 拒绝登记')
    assert.equal(producer.begin({ runId: 'sub-nocode', code: '' }), false, '空编号拒绝登记')
    ok('未知 runId / 空标识是空操作，不伪造编号或运行')

    await host.dispose()
    console.log('\n评审运行 producer：全部通过')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

await run()
