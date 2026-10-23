import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const temp = await mkdtemp(join(tmpdir(), 'inkstone-session-metrics-'))
try {
  await build({
    entryPoints: ['src/shared/session-metrics.ts'],
    bundle: true,
    platform: 'neutral',
    format: 'esm',
    outfile: join(temp, 'session-metrics.mjs'),
    logLevel: 'silent'
  })
  const {
    liveActivitySince,
    liveStepId,
    projectSessionMetrics,
    sessionTurnCounts,
    splitLiveStep,
    stepSpeed
  } = await import(pathToFileURL(resolve(temp, 'session-metrics.mjs')).href)

  let checks = 0
  const check = (condition, message) => {
    assert.ok(condition, message)
    checks += 1
  }
  const eq = (actual, expected, message) => {
    assert.deepEqual(actual, expected, message)
    checks += 1
  }

  const usage = (o) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, ...o })
  const tool = (o) => ({ id: 't', name: 'bash', args: {}, status: 'ok', ...o })
  const stats = (o) => ({ cost: 0, userMessages: 0, assistantMessages: 0, toolCalls: 0, ...o })
  const NOTICE =
    '<subagent-notification id="s1" status="done">\n这是宿主自动发出的通知，不是用户的新消息：请据此继续原任务或汇总结果，不要复述本通知。'

  {
    const messages = [
      { id: 'u1', role: 'user', text: 'hi' },
      {
        id: 'a1',
        role: 'assistant',
        text: 'working',
        toolCalls: [tool({ id: 't1', startedAt: 1000, endedAt: 2000 })],
        usage: usage({ input: 100, output: 10 }),
        speed: 20
      },
      {
        id: 'a2',
        role: 'assistant',
        text: 'done',
        toolCalls: [tool({ id: 't2', name: 'read', startedAt: 1800, endedAt: 2500 })],
        usage: usage({ input: 200, output: 30, cacheRead: 300 })
      }
    ]
    const m = projectSessionMetrics(messages, null)
    eq(m.turns, 1, '轮数 = 有回答的用户回合')
    eq(m.steps, 2, '步数 = assistant 请求数，不是工具次数')
    eq(m.source, 'messages', '没有 stats 时用消息求和')
    eq(m.total, 640, '累计 = input + output + cacheRead + cacheWrite')
    eq(m.input, 300, '累计未缓存输入')
    eq(m.output, 40, '累计输出')
    eq(m.cacheRead, 300, '累计缓存读')
    eq(m.cacheWrite, null, '缓存写为 0 → null（界面藏行）')
    eq(m.partial, false, '全部报用量时不是下限')
    eq(m.cost, null, 'stats 未加载 → 花费 null，不当 0')
    eq(m.modelMs, null, '只有 speed、没有 generationTiming → 模型总用时未知')
    eq(m.modelPartial, false, '完全未知不是「部分」，是缺')
    eq(m.tps, 20, '旧 speed 作为已记录 TPS 仍可参与（a1：10 tok / 0.5s）')
    check(m.tpsPartial === true, '有请求没有计时 → TPS 只覆盖部分步数')
    eq(m.ttftMs, null, '没有 generationTiming.ttftMs → TTFT 未知，不编造')
    eq(m.toolMs, 1500, '工具用时取区间并集（重叠不重复计）')
    eq(m.toolPartial, false, '起止齐全时不是下限')
  }

  {
    const messages = [
      { id: 'u1', role: 'user', text: 'hi' },
      { id: 'a1', role: 'assistant', text: 'x', usage: usage({ input: 100, output: 10 }) },
      { id: 'a2', role: 'assistant', text: 'y', usage: usage({ input: 200, output: 30, cacheRead: 300 }) }
    ]
    const s = stats({
      tokens: { input: 1000, output: 100, cacheRead: 900, cacheWrite: 0, total: 2000 },
      cost: 0.5,
      userMessages: 1,
      assistantMessages: 2
    })
    const m = projectSessionMetrics(messages, s)
    eq(m.source, 'stats', 'stats 与消息对得上时优先用 stats')
    eq(m.total, 2000, '累计 Token 取 stats')
    eq(m.input, 1000, '未缓存输入取 stats')
    eq(m.cacheWrite, null, 'stats 缓存写为 0 → 藏行')
    eq(m.partial, false, '每个可见请求都报过 → 不是下限')
    eq(m.cost, 0.5, '花费取 stats')
    eq(m.costZero, false, '花费非 0 时不提示')
    eq(m.hitRate, 900 / 1900 * 100, '命中率 = 缓存读 /（未缓存输入 + 缓存读 + 缓存写）')
    const withWrite = projectSessionMetrics(messages, { ...s, tokens: { ...s.tokens, cacheWrite: 50, total: 2050 } })
    eq(withWrite.hitRate, 900 / (1000 + 900 + 50) * 100, '缓存写入计入命中率分母')
  }

  {
    const messages = [
      { id: 'u1', role: 'user', text: 'hi' },
      { id: 'a1', role: 'assistant', text: 'x', usage: usage({ input: 100, output: 10 }) }
    ]
    const s = stats({
      tokens: { input: 9999, output: 9999, cacheRead: 0, cacheWrite: 0, total: 19998 },
      cost: 9,
      userMessages: 8,
      assistantMessages: 9,
      toolCalls: 3
    })
    const m = projectSessionMetrics(messages, s, { historyPartial: true })
    eq(m.source, 'stats', 'stats 请求数多于可见消息也直接采信（可见只是截断的历史）')
    eq(m.total, 19998, '累计取权威 stats 的全会话值')
    eq(m.input, 9999, '未缓存输入取 stats')
    eq(m.partial, false, '历史截断 + 权威完整 stats → 不标下限')
    eq(m.cost, 9, '花费取 stats')
    const noFlag = projectSessionMetrics(messages, s)
    eq(noFlag.source, 'stats', '没有传入截断标记时同样信 stats（归属由 store 保证）')
    eq(noFlag.total, 19998, '总数仍取 stats')
  }

  {
    const messages = [
      { id: 'u1', role: 'user', text: 'hi' },
      { id: 'a1', role: 'assistant', text: 'x', usage: usage({ input: 400, output: 100 }) }
    ]
    const s = stats({
      tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
      cost: 0.2,
      userMessages: 1,
      assistantMessages: 1
    })
    const m = projectSessionMetrics(messages, s)
    eq(m.source, 'messages', 'stats 落后于消息 → 用消息的新值')
    eq(m.total, 500, '累计取消息求和')
    check(m.partial === true, 'stats 更旧 → 统计/花费可能部分，标下限')
    eq(m.cost, 0.2, '花费仍来自 stats（归属没变）')
  }

  {
    const messages = [
      { id: 'u1', role: 'user', text: 'q' },
      { id: 'a1', role: 'assistant', text: 'a', usage: usage({ input: 10, output: 5 }) },
      { id: 'a1', role: 'assistant', text: 'dup', usage: usage({ input: 999, output: 999 }) },
      { id: 'notice', role: 'user', text: NOTICE },
      { id: 'qlog:1', role: 'user', question: true, text: 'host question' },
      { id: 'a2', role: 'assistant', text: 'a2', usage: usage({ input: 20, output: 5 }) }
    ]
    const m = projectSessionMetrics(messages, null)
    eq(m.turns, 1, '提问回答与子代理通知不另起新回合')
    eq(m.steps, 2, '重复 id 只算一次请求')
    eq(m.input, 1019, '重复 id 取后者权威值（999 + 20），不吃旧值')
    eq(m.output, 1004, '重复 id 取后者权威值（999 + 5）')
    eq(m.total, 2023, '累计只按去重后的消息求和')
  }

  {
    const messages = [
      { id: 'u1', role: 'user', text: 'hi' },
      {
        id: 'a1',
        role: 'assistant',
        text: 'x',
        usage: usage({ output: 100 }),
        generationTiming: { durationMs: 2000, ttftMs: 400, decodeMs: 1600, startEvent: 'turn_start' }
      },
      {
        id: 'a2',
        role: 'assistant',
        text: 'y',
        usage: usage({ output: 50 }),
        generationTiming: { durationMs: 1000, ttftMs: 200, decodeMs: 800, startEvent: 'turn_start' }
      }
    ]
    const m = projectSessionMetrics(messages, null)
    eq(m.modelMs, 3000, '模型用时 = Σ generationTiming.durationMs')
    eq(m.ttftMs, 300, '平均 TTFT = Σ ttftMs / 请求数')
    eq(m.tps, 150 / 2.4, 'TPS = Σ output / Σ decodeMs')
    eq(m.modelPartial, false, '计时齐全且都带原生起点标记时不是下限')
    eq(m.ttftPartial, false, 'TTFT 齐全时不是部分')
    eq(m.tpsPartial, false, '输出都被真实 decode 覆盖时不是部分')
  }

  {
    const messages = [
      { id: 'u1', role: 'user', text: 'hi' },
      {
        id: 'a1',
        role: 'assistant',
        text: 'x',
        usage: usage({ output: 100 }),
        generationTiming: { durationMs: 2000, ttftMs: 400, decodeMs: 1600 }
      }
    ]
    const m = projectSessionMetrics(messages, null)
    eq(m.modelMs, 2000, '无标记的 duration 仍计入模型总用时（数值照旧）')
    check(m.modelPartial === true, '无标记的 duration 只是流下限 → 模型用时标 ≥')
    eq(m.ttftMs, null, '无标记的 ttft 不进平均（不拿流下限冒充请求首包延迟）')
    eq(m.ttftPartial, false, '一个可用的 ttft 都没有时是未知，不是部分')
    eq(m.tps, 100 / 1.6, 'decodeMs 与起点语义无关，TPS 照常可用')
  }

  {
    const messages = [
      { id: 'u1', role: 'user', text: 'hi' },
      {
        id: 'a1',
        role: 'assistant',
        text: 'x',
        toolCalls: [
          tool({ id: 't1', startedAt: 0, endedAt: 1000 }),
          tool({ id: 't2', startedAt: 500, endedAt: 1500 }),
          tool({ id: 't3', status: 'running' })
        ]
      }
    ]
    const m = projectSessionMetrics(messages, null)
    eq(m.toolMs, 1500, '并集 = 0..1500，不是逐段相加')
    eq(m.toolPartial, true, '有工具没有完整起止 → 用时是部分')
  }

  {
    const messages = [
      { id: 'u1', role: 'user', text: 'hi' },
      { id: 'a1', role: 'assistant', text: 'x', usage: usage({ output: 10 }) }
    ]
    const m = projectSessionMetrics(messages, null)
    eq(m.modelMs, null, '没有 generationTiming 也没有 speed → 模型用时未知')
    eq(m.tps, null, '没有可用的生成时间 → TPS 未知')
    eq(m.ttftMs, null, 'TTFT 未知')
    eq(m.modelPartial, false, '未知不是「部分」，是缺')
    eq(m.tpsPartial, true, '有请求没被计时覆盖 → TPS 值不完整')
  }

  {
    const messages = [
      { id: 'u1', role: 'user', text: 'hi' },
      { id: 'a1', role: 'assistant', text: 'x', usage: usage({ input: 10, output: 5 }) }
    ]
    const s = stats({
      tokens: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, total: 120 },
      cost: 0,
      userMessages: 1,
      assistantMessages: 1
    })
    const m = projectSessionMetrics(messages, s)
    eq(m.cost, 0, 'stats 报 0 时花费就是 0，但…')
    eq(m.costZero, true, '…会话已有 Token → 标记花费不可信')
  }

  {
    const messages = [
      { id: 'u1', role: 'user', text: 'hi' },
      { id: 'a1', role: 'assistant', text: 'x' },
      { id: 'a2', role: 'assistant', text: 'y' }
    ]
    const m = projectSessionMetrics(messages, null)
    eq(m.total, null, '一条都没报 → 未知，显示 —')
    eq(m.partial, false, '未知不标 ≥')
    eq(m.steps, 2, '步数照常按请求数')
  }

  {
    const messages = [
      { id: 'u1', role: 'user', text: 'hi' },
      { id: 'a1', role: 'assistant', text: 'x' },
      { id: 'a2', role: 'assistant', text: 'y' }
    ]
    const s = stats({
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      assistantMessages: 2
    })
    const m = projectSessionMetrics(messages, s)
    eq(m.total, null, '已请求但全缺报、stats 也是 0 → 累计未知，不显示 0')
    eq(m.input, null, '分项同样未知')
    eq(m.source, 'none', '没有可用的权威累计')
    eq(m.partial, false, '未知不标 ≥')
    eq(m.cost, 0, '花费仍来自 stats')
    eq(m.costZero, false, '没有 Token 可对照，不能当免费提示')
  }

  {
    const messages = [
      { id: 'u1', role: 'user', text: 'hi' },
      { id: 'a1', role: 'assistant', text: 'x', usage: usage({ input: 10, output: 5 }) },
      { id: 'a2', role: 'assistant', text: 'y' }
    ]
    const s = stats({
      tokens: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, total: 120 },
      cost: 0.1,
      assistantMessages: 2
    })
    const full = projectSessionMetrics(messages, s)
    eq(full.source, 'stats', 'stats 仍旧优先')
    eq(full.total, 120, '累计取 stats')
    check(full.partial === true, '可见请求缺 usage → stats 有值也可以是下限')

    const truncated = projectSessionMetrics(messages, s, { historyPartial: true })
    eq(truncated.partial, false, '历史截断且 stats 是完整会话值 → 不标下限')
  }

  {
    const messages = [
      { id: 'u1', role: 'user', text: 'hi' },
      { id: 'a1', role: 'assistant', text: 'x', usage: usage({ input: 10, output: 5 }) }
    ]
    const truncated = projectSessionMetrics(messages, null, { historyPartial: true })
    eq(truncated.source, 'messages', '没有 stats 时用消息求和')
    eq(truncated.total, 15, '可见部分求和')
    check(truncated.partial === true, '截断 + 无完整 stats → 累计必须标下限')
    const full = projectSessionMetrics(messages, null)
    eq(full.partial, false, '完整历史且都报过 → 不是下限')
  }

  {
    const messages = [
      { id: 'u1', role: 'user', text: 'hi' },
      {
        id: 'a1',
        role: 'assistant',
        text: 'x',
        usage: usage({ output: 100 }),
        generationTiming: { durationMs: 2000, startEvent: 'turn_start' }
      }
    ]
    const m = projectSessionMetrics(messages, null)
    eq(m.modelMs, 2000, 'durationMs 仍是模型总用时')
    eq(m.modelPartial, false, '这个请求有带原生起点的完整计时记录')
    eq(m.tps, null, '没有 decodeMs 也不回退 durationMs → TPS 未知，不编造')
    check(m.tpsPartial === true, '有输出但没真实 decode → TPS 不完整')
    eq(m.ttftMs, null, '没有首包 → TTFT 未知')
    eq(m.ttftPartial, false, '一个 ttft 都没有时是未知，不是「部分」')
  }

  {
    const messages = [
      { id: 'u1', role: 'user', text: 'hi' },
      { id: 'a1', role: 'assistant', text: 'x', usage: usage({ output: 100 }), speed: 50 }
    ]
    const m = projectSessionMetrics(messages, null)
    eq(m.modelMs, null, 'speed 只覆盖解码段，补不出首包 → 模型总用时未知')
    eq(m.modelPartial, false, '完全未知不是「部分」')
    eq(m.tps, 50, '旧 speed 作为已记录 TPS 仍可用')
    eq(m.tpsPartial, false, '这一步被已记录 TPS 覆盖')
  }

  {
    const messages = [
      { id: 'u1', role: 'user', text: 'hi' },
      {
        id: 'a1',
        role: 'assistant',
        text: 'x',
        usage: usage({ input: Infinity, output: -5, cacheRead: NaN, cacheWrite: 10, totalTokens: Infinity }),
        generationTiming: { durationMs: Infinity, decodeMs: NaN, ttftMs: -1 },
        speed: Infinity,
        toolCalls: [
          tool({ id: 't1', startedAt: 0, endedAt: 1000 }),
          tool({ id: 't2', startedAt: NaN, endedAt: 2000 }),
          tool({ id: 't3', startedAt: 0, endedAt: Infinity })
        ]
      }
    ]
    const m = projectSessionMetrics(messages, null)
    eq(m.total, 10, '非有限/负数的 usage 归 0，只留 cacheWrite 10')
    eq(m.input, 0, 'Infinity 输入归 0')
    eq(m.output, 0, '负数输出归 0')
    eq(m.cacheRead, 0, 'NaN 缓存读归 0')
    eq(m.cacheWrite, 10, '合法缓存写保留')
    eq(m.modelMs, null, 'Infinity durationMs 不算有效计时')
    eq(m.modelPartial, false, '没有有效计时 → 未知')
    eq(m.tps, null, 'Infinity/NaN 的 decode 不产生 TPS')
    eq(m.ttftMs, null, '负数 ttft 不算有效')
    eq(m.toolMs, 1000, '只保留有效的工具区间')
    eq(m.toolPartial, true, '有两个工具的起止不合规 → 用时是部分')

    const s = stats({
      tokens: { input: NaN, output: 0, cacheRead: 0, cacheWrite: 0, total: Infinity },
      cost: Infinity,
      assistantMessages: 1
    })
    const bad = projectSessionMetrics([{ id: 'u1', role: 'user', text: 'hi' }, { id: 'a1', role: 'assistant', text: 'x' }], s)
    eq(bad.total, null, 'stats 的 Infinity 总量归 0 → 与「未知」一致')
    eq(bad.cost, 0, 'Infinity 花费归 0，不传出精确的错误值')
  }

  {
    const messages = [
      { id: 'u1', role: 'user', text: 'hi' },
      { id: 'a1', role: 'assistant', text: 'no usage no timing' },
      {
        id: 'a2',
        role: 'assistant',
        text: 'y',
        usage: usage({ output: 10 }),
        generationTiming: { durationMs: 1000, decodeMs: 800, ttftMs: 100, startEvent: 'turn_start' }
      }
    ]
    const m = projectSessionMetrics(messages, null)
    eq(m.steps, 2, '两步请求')
    eq(m.modelMs, 1000, '只累计有计时的那一步')
    check(m.modelPartial === true, '有请求没有计时（含无 usage 的）→ 模型用时是下限')
    eq(m.tps, 12.5, 'TPS 只用真实 output 配真实 decodeMs')
    check(m.tpsPartial === true, '覆盖率按实际 steps 算 → TPS 不完整')
    eq(m.ttftMs, 100, 'TTFT 只算已记录的那一步')
    check(m.ttftPartial === true, 'TTFT 请求数 < steps → 部分')
    check(m.partial === true, '有请求缺 usage → 累计是下限')
  }

  {
    const messages = [
      { id: 'u1', role: 'user', text: 'hi' },
      {
        id: 'a1',
        role: 'assistant',
        text: 'x',
        usage: usage({ output: 100 }),
        generationTiming: { durationMs: 500, startEvent: 'turn_start' },
        speed: 200
      }
    ]
    const m = projectSessionMetrics(messages, null)
    eq(m.modelMs, 500, 'durationMs 仍计入模型用时')
    eq(m.modelPartial, false, '这一步有带原生起点的计时记录')
    eq(m.tps, null, '有 gt 却无 decodeMs → 不拿旧 speed 兜底，TPS 未知')
    check(m.tpsPartial === true, '有输出未被真实 decode 覆盖 → TPS 不完整')
    eq(m.ttftMs, null, '没有 ttftMs → TTFT 未知')

    const decoded = projectSessionMetrics([
      { id: 'u1', role: 'user', text: 'hi' },
      {
        id: 'a2',
        role: 'assistant',
        text: 'y',
        usage: usage({ output: 100 }),
        generationTiming: { durationMs: 500, decodeMs: 400, startEvent: 'turn_start' },
        speed: 999
      }
    ], null)
    eq(decoded.tps, 250, '有 decodeMs 时优先用真实解码时间（100 tok / 0.4s）')
    eq(decoded.tpsPartial, false, '有真实 decode → TPS 完整')

    const legacy = projectSessionMetrics([
      { id: 'u1', role: 'user', text: 'hi' },
      { id: 'a3', role: 'assistant', text: 'z', usage: usage({ output: 100 }), speed: 50 }
    ], null)
    eq(legacy.tps, 50, '没有 generationTiming 时旧 speed 仍兼容')
    eq(legacy.modelMs, null, '旧 speed 不充模型总用时')
  }

  {
    const messages = [
      { id: 'u1', role: 'user', text: 'hi' },
      {
        id: 'a1',
        role: 'assistant',
        text: 'x',
        usage: usage({ output: 100 }),
        generationTiming: { durationMs: 2000, ttftMs: 400, decodeMs: 1600, startEvent: 'turn_start' },
        toolCalls: [tool({ id: 't1', startedAt: 0, endedAt: 1000 })]
      }
    ]
    const m = projectSessionMetrics(messages, null, { historyPartial: true })
    eq(m.modelMs, 2000, '可见部分的模型用时求和')
    check(m.modelPartial === true, '历史截断时模型用时是可见部分的下限')
    eq(m.toolMs, 1000, '可见部分的工具区间并集')
    check(m.toolPartial === true, '历史截断时工具用时是可见部分的下限')
    check(m.tps !== null, '可见部分能算出 TPS')
    check(m.tpsPartial === true, '历史截断时有值的 TPS 仍是部分')
    check(m.ttftMs !== null, '可见部分的 TTFT')
    check(m.ttftPartial === true, '历史截断时有值的 TTFT 仍是部分')

    const noTiming = projectSessionMetrics([
      { id: 'u1', role: 'user', text: 'hi' },
      { id: 'a1', role: 'assistant', text: 'x', usage: usage({ output: 100 }) }
    ], null, { historyPartial: true })
    eq(noTiming.modelMs, null, '没有计时记录 → 模型用时仍未知')
    eq(noTiming.tps, null, '没有计时记录 → TPS 仍未知')
    eq(noTiming.ttftMs, null, '没有计时记录 → TTFT 仍未知')

    const noTools = projectSessionMetrics([
      { id: 'u1', role: 'user', text: 'hi' },
      { id: 'a1', role: 'assistant', text: 'x', usage: usage({ output: 100 }) }
    ], null, { historyPartial: true })
    eq(noTools.toolMs, 0, '可见没有工具 → 并集 0')
    check(noTools.toolPartial === true, '历史截断时「0 工具用时」也是可见部分的下限')
  }

  {
    const timing = { durationMs: 10_000, decodeMs: 1000, ttftMs: 9000, startEvent: 'turn_start' }
    const hidden = projectSessionMetrics([
      { id: 'u1', role: 'user', text: 'hi' },
      { id: 'a1', role: 'assistant', text: 'answer', usage: usage({ output: 1100, reasoning: 1000 }), generationTiming: timing }
    ], null)
    eq(hidden.tps, 100, '推理没流出来时只按可见输出算速度（1100-1000 / 1s）')
    const shown = projectSessionMetrics([
      { id: 'u1', role: 'user', text: 'hi' },
      { id: 'a1', role: 'assistant', text: 'answer', thinking: 'visible reasoning', usage: usage({ output: 1100, reasoning: 1000 }), generationTiming: timing }
    ], null)
    eq(shown.tps, 1100, '推理已流式显示时整段输出都在解码窗口内')
  }

  {
    const burst = projectSessionMetrics([
      { id: 'u1', role: 'user', text: 'hi' },
      { id: 'a1', role: 'assistant', text: 'x', usage: usage({ output: 500 }), generationTiming: { durationMs: 2000, decodeMs: 5, ttftMs: 1995, startEvent: 'turn_start' } }
    ], null)
    eq(burst.tps, 250, '整段一次到达（解码只有几毫秒）时改用整段时长')
    check(burst.tpsPartial === true, '整段时长算出的速度是下限，标 ≥')
    const fast = projectSessionMetrics([
      { id: 'u1', role: 'user', text: 'hi' },
      { id: 'a1', role: 'assistant', text: 'x', usage: usage({ output: 2000 }), generationTiming: { durationMs: 1500, decodeMs: 1000, ttftMs: 500, startEvent: 'turn_start' } }
    ], null)
    eq(fast.tps, 2000, '真实的高速流式不被当成异常')
    check(fast.tpsPartial === false, '正常记录不标下限')
  }

  {
    const withError = projectSessionMetrics([
      { id: 'u1', role: 'user', text: 'hi' },
      { id: 'a0', role: 'assistant', text: '', error: 'boom', usage: usage({}) },
      { id: 'a1', role: 'assistant', text: 'ok', usage: usage({ output: 100 }), generationTiming: { durationMs: 1500, decodeMs: 1000, ttftMs: 500, startEvent: 'turn_start' } }
    ], null)
    check(withError.tpsPartial === false && withError.ttftPartial === false, '报错的请求没有输出，不让速度与首个输出一直显示「部分缺失」')
  }

  {
    const msgs = [
      { id: 'u1', role: 'user', text: 'hi', timestamp: 1 },
      { id: 'a1', role: 'assistant', text: 'x', timestamp: 10, usage: usage({ input: 100, cacheRead: 900, output: 50 }) },
      { id: 'a2', role: 'assistant', text: 'y', timestamp: 20, usage: usage({ input: 200, cacheRead: 0, output: 30 }) }
    ]
    const snapshot = stats({ tokens: { input: 5100, output: 550, cacheRead: 900, cacheWrite: 0, total: 6550 }, countedUntil: 10 })
    const live = projectSessionMetrics(msgs, snapshot)
    eq(live.source, 'stats', '快照之后的新消息不让来源跳到消息累加')
    eq(live.total, 6550 + 230, '两次刷新之间 = 快照 + 快照之后的新消息')
    eq(live.input, 5300, '分项同样补上新消息')
    const settled = projectSessionMetrics(msgs, { ...snapshot, countedUntil: 20, tokens: { ...snapshot.tokens, input: 5300, output: 580, total: 6780 } })
    eq(settled.total, 6780, '新快照覆盖后不重复计入')
    const legacy = projectSessionMetrics(msgs, stats({ tokens: { input: 5100, output: 550, cacheRead: 900, cacheWrite: 0, total: 6550 } }))
    eq(legacy.total, 6550, '旧快照没有计数边界时不猜，维持原逻辑')
    const none = projectSessionMetrics(msgs, stats({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, countedUntil: null }))
    eq(none.total, 1280, '快照里还没有对话请求时，全部消息都算新增')
  }

  {
    const msgs = [
      { id: 'u1', role: 'user', text: 'hi', timestamp: 1 },
      { id: 'a1', role: 'assistant', text: 'x', timestamp: 10, usage: usage({ input: 100, cacheRead: 900 }) },
      { id: 'a2', role: 'assistant', text: 'y', timestamp: 20, usage: usage({ input: 300, cacheRead: 100 }) },
      { id: 'a3', role: 'assistant', text: '', timestamp: 30, error: 'boom', usage: usage({ input: 50 }) }
    ]
    const m = projectSessionMetrics(msgs, stats({
      tokens: { input: 2450, output: 500, cacheRead: 1000, cacheWrite: 0, total: 3950 },
      countedUntil: 30,
      overheadUsage: { input: 2000, output: 500, cacheRead: 0, cacheWrite: 0 }
    }))
    eq(m.total, 3950, '总数仍含压缩与预热（按会话文件计）')
    eq(m.hitRate, 1000 / 1450 * 100, '累计命中率扣掉压缩与预热请求')
    check(m.overheadExcluded === true, '标记命中率已扣除非对话请求')
    eq(m.latestHitRate, 100 / 400 * 100, '最近一次命中率取最后一条成功请求（跳过报错的）')
    const derived = projectSessionMetrics(msgs, null)
    eq(derived.hitRate, 1000 / 1450 * 100, '没有快照时按消息累加，本来就不含压缩')
    check(derived.overheadExcluded === false, '按消息累加时不标扣除')
  }

  {
    const done = {
      id: 'a1',
      role: 'assistant',
      text: 'one',
      usage: usage({ input: 100, output: 50 }),
      generationTiming: { durationMs: 2000, decodeMs: 1000, startEvent: 'turn_start', ttftMs: 300 },
      toolCalls: [tool({ id: 't1', startedAt: 10_000, endedAt: 12_000 })]
    }
    const streaming = { id: 'a2', role: 'assistant', text: 'tw', timestamp: 20_000, generationTiming: { durationMs: 400 } }
    const msgs = [{ id: 'u1', role: 'user', text: 'go' }, done, streaming]

    eq(liveStepId(msgs, false), null, '未流式时没有进行中的一步')
    eq(liveStepId(msgs, true), 'a2', '流式时末尾 assistant 是进行中的一步')
    eq(liveStepId([...msgs, { id: 'n', role: 'user', text: NOTICE }], true), 'a2', '子代理通知不打断判断')
    eq(liveStepId([...msgs, { id: 'u2', role: 'user', text: 'next' }], true), null, '末尾是用户消息时没有进行中的一步')

    const split = splitLiveStep(msgs, 'a2')
    eq(split.settled.map((m) => m.id), ['u1', 'a1'], '已结算范围去掉进行中的一步')
    eq(split.live?.id, 'a2')
    eq(splitLiveStep(msgs, null).settled, msgs, '无进行中时原样返回')
    eq(splitLiveStep(msgs, 'zz').live, null)

    const settled = projectSessionMetrics(split.settled, null)
    const all = projectSessionMetrics(msgs, null)
    check(all.partial === true, '把进行中这一步算进来会误报缺数据')
    check(settled.partial === false, '只按已结算步骤计时不会闪出 ≥')
    check(settled.modelPartial === false, '进行中的计时不拉低已结算用时')
    eq(settled.total, 150)
    eq(sessionTurnCounts(msgs), { turns: 1, steps: 2 }, '头部轮数与步数含进行中的一步')

    eq(stepSpeed(done), 50, '已结算步骤速度')
    eq(stepSpeed({ id: 'x', role: 'assistant', text: '' }), null)

    eq(liveActivitySince(msgs, split.live, false), null, '未运行时不计进行中用时')
    eq(liveActivitySince(msgs, split.live, true), 20_000, '进行中从这一步开始计')
    const toolRunning = [
      { id: 'u1', role: 'user', text: 'go' },
      { ...done, toolCalls: [tool({ id: 't2', status: 'running', startedAt: 15_000 }), tool({ id: 't3', status: 'ok', startedAt: 14_000, endedAt: 14_500 })] }
    ]
    eq(liveActivitySince(toolRunning, null, true), 15_000, '工具执行中按最早未结束的工具计')
    eq(liveActivitySince([{ ...done, toolCalls: [tool({ id: 't4', status: 'running', startedAt: 1 })] }, { id: 'u2', role: 'user', text: 'new' }], null, true), null, '只看最后一条用户消息之后')
  }

  console.log(`session-metrics: ${checks} checks passed`)
} finally {
  await rm(temp, { recursive: true, force: true })
}
