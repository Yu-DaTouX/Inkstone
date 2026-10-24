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

async function run() {
  const dir = await mkdtemp(join(tmpdir(), 'inkstone-working-line-'))
  try {
    const m = await compile('src/renderer/src/features/session/working-line-model.ts', join(dir, 'working-line.mjs'))
    const stop = await compile('src/renderer/src/features/session/stop-intent.ts', join(dir, 'stop-intent.mjs'))
    const base = { running: true, elapsedMs: 5400, now: 100_000 }

    assert.equal(m.workingLine({ running: false, elapsedMs: null, now: 0 }), null)

    const sending = m.workingLine({ ...base, elapsedMs: 1500 })
    assert.equal(sending.kind, 'sending')
    assert.equal(sending.elapsedMs, null, '不足 2 秒不显示秒数')

    const working = m.workingLine({ ...base, requested: true, tokens: 1234 })
    assert.equal(working.kind, 'working')
    assert.equal(working.elapsedMs, 5000, '秒数对齐整秒')
    assert.equal(working.tokens, 1234)
    assert.equal(m.workingLine({ ...base, requested: true, streaming: true, quiet: true }).quiet, true, '已有生成参数工具辉光时，正文状态行保持安静')
    assert.equal(m.workingLine({ ...base, requested: true, waiting: true, quiet: true }).quiet, false, '等待用户操作仍明确可见')
    assert.equal(m.workingLine({ ...base, requested: true, tokens: 0 }).tokens, null, '没有 token 时不显示')

    const order = { ...base, requested: true, stopping: true, waiting: true, retry: { attempt: 2, maxAttempts: 3, at: 99_000, delayMs: 4000 }, compacting: true, toolRunning: true }
    assert.equal(m.workingLine(order).kind, 'stopping', '停止中优先')
    assert.equal(m.workingLine({ ...order, stopping: false }).kind, 'waiting')
    assert.equal(m.workingLine({ ...order, stopping: false }).elapsedMs, null, '等待用户不计秒')
    const retry = m.workingLine({ ...order, stopping: false, waiting: false, tokens: 50 })
    assert.equal(retry.kind, 'retrying')
    assert.equal(retry.textKey, 'workRetryWait')
    assert.deepEqual(retry.vars, { n: 2, m: 3, s: 3 })
    assert.equal(retry.tokens, null, '重试不显示 token')
    assert.equal(retry.elapsedMs, 5000, '重试与运行共用时钟')
    const retryNow = m.workingLine({ ...base, retry: { attempt: 1, maxAttempts: 3, at: 90_000, delayMs: 1000, error: '503' } })
    assert.equal(retryNow.textKey, 'workRetry')
    assert.equal(retryNow.error, '503')
    assert.equal(m.workingLine({ ...order, stopping: false, waiting: false, retry: null }).kind, 'compacting')
    assert.equal(m.workingLine({ ...base, running: false, compacting: true, elapsedMs: null }).kind, 'compacting', '单独压缩也显示')
    const tool = m.workingLine({ ...base, toolRunning: true, quiet: true, tokens: 9 })
    assert.equal(tool.kind, 'tool')
    assert.equal(tool.quiet, true, '运行中的工具行已显示时工作行静默占位')
    assert.equal(m.workingLine({ ...base, stopping: true, running: false, elapsedMs: null }), null, '运行结束后不再显示停止中')

    assert.equal(m.thinkingTextKey(0), 'workThink0')
    assert.equal(m.thinkingTextKey(14_999), 'workThink0')
    assert.equal(m.thinkingTextKey(15_000), 'workThink15')
    assert.equal(m.thinkingTextKey(30_000), 'workThink30')
    assert.equal(m.thinkingTextKey(45_000), 'workThink45')
    assert.equal(m.thinkingTextKey(60_000), 'workThink60')
    assert.equal(m.thinkingTextKey(600_000), 'workThink60')

    let clock = m.trackThinking(null, { identity: 't1', live: true, now: 10_000 })
    assert.equal(clock.startedAt, 10_000)
    clock = m.trackThinking(clock, { identity: 't1', live: true, now: 26_000 })
    assert.equal(clock.startedAt, 10_000, '思考中保持起点')
    const thinking = m.workingLine({ ...base, now: 26_000, thinking: clock, requested: true })
    assert.equal(thinking.kind, 'thinking')
    assert.equal(thinking.textKey, 'workThink15')
    clock = m.trackThinking(clock, { identity: 't1', live: false, ms: 16_400, now: 26_500 })
    assert.equal(clock.endedAt, 26_500)
    assert.equal(clock.ms, 16_400)
    const thought = m.workingLine({ ...base, now: 28_000, thinking: clock, requested: true, streaming: true })
    assert.equal(thought.kind, 'thought', '思考结束后保持 2 秒')
    assert.deepEqual(thought.vars, { n: 16 })
    assert.equal(m.workingLine({ ...base, now: 28_600, thinking: clock, requested: true, streaming: true }).kind, 'responding', '2 秒后回到作答')
    const measured = m.trackThinking(m.trackThinking(null, { identity: 't2', live: true, now: 0 }), { identity: 't2', live: false, now: 3000 })
    assert.equal(measured.ms, 3000, '没有 thinkingMs 时用测得的时长')
    const reset = m.trackThinking(clock, { identity: 't3', live: false, now: 27_000 })
    assert.equal(reset.endedAt, null, '换回合后丢弃旧的思考状态')

    const messages = [
      { id: 'u0', role: 'user' },
      { id: 'a0', role: 'assistant', usage: { output: 999 } },
      { id: 'u1', role: 'user' },
      { id: 'a1', role: 'assistant', usage: { output: 1200 } },
      { id: 'a2', role: 'assistant', usage: { output: 300 } },
      { id: 'a3', role: 'assistant' }
    ]
    assert.equal(m.turnOutputTokens(messages, 'u1'), 1500, '只累加本回合的 usage')
    assert.equal(m.turnOutputTokens(messages, 'missing'), null, '回合身份对不上时不显示')
    assert.equal(m.turnOutputTokens(messages, null), null)
    assert.equal(m.turnOutputTokens([{ id: 'u1', role: 'user' }, { id: 'a1', role: 'assistant' }], 'u1'), null, '没有 usage 时不推断')
    assert.equal(m.turnOutputTokens([...messages, { id: 'a1', role: 'assistant', usage: { output: 1200 } }], 'u1'), 1500, '同一条消息的快照不重复累加')

    assert.equal(m.formatTokenCount(0), '0')
    assert.equal(m.formatTokenCount(999), '999')
    assert.equal(m.formatTokenCount(1000), '1k')
    assert.equal(m.formatTokenCount(1234), '1.2k')
    assert.equal(m.formatTokenCount(999_950), '1M')
    assert.equal(m.formatTokenCount(2_345_678), '2.3M')
    assert.equal(m.formatTokenCount(3_000_000_000), '3B')

    stop.markStopRequested('s1', 5000)
    const intent = stop.stopIntent()
    assert.equal(stop.isStopRequested(intent, 's1', 4000), true)
    assert.equal(stop.isStopRequested(intent, 's1', 6000), false, '之后新开的运行不算停止中')
    assert.equal(stop.isStopRequested(intent, 's2', 4000), false, '别的会话不算')
    stop.markStopRequested(undefined)
    assert.equal(stop.stopIntent().sessionId, 's1', '没有会话时不记')

    console.log('working-line-model：全部通过')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

await run()
