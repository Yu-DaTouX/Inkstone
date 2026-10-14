/**
 * 会话统计投影（纯函数）—— 输入框下方的两个入口与状态栏花费详情共用同一份口径。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么单独一层
 * ══════════════════════════════════════════════════════════════════
 * 会话级用量不能拿「当前回合」的值冒充：新一轮流式刚开始时，上一轮的数字看着
 * 还挺新，混进会话累计就会把「本会话一共用了多少」说错。这里一次性把
 * 轮数 / 步数 / 累计 Token / 缓存命中率 / 模型与工具用时 / TTFT / TPS 从
 * 消息与 pi 的会话统计里算出来，两个组件只负责展示。
 *
 * 口径要点：
 *   · 轮数 = **有模型回答**的用户回合；步数 = 实际 assistant 请求数（每条 assistant
 *     消息 = 一次请求），**不是**工具调用次数。
 *   · 排除宿主子代理通知与提问回答；同 id 重复时后者权威（补丁/终态），但保留首次
 *     出现的位置。
 *   · 累计 Token 优先用 pi 的 `stats` —— 归属已由 store 在切会话时同步清空、运行时
 *     按身份路由保证，这里不再拿「请求数更多」猜它属于别的会话（长历史截断会误判）。
 *     只有 stats 比消息求和还旧/更低时才回退消息求和。逐条请求缺报用量是**下限**
 *     （界面标 `≥`），一条都没报是未知（显示 `—`）；只有 `historyPartial` 且 stats
 *     是完整会话值时才算完整累计。
 *   · 计时只用**已记录**的值：模型总用时只加 `generationTiming.durationMs`，不拿旧
 *     `speed` 反推（补不出首包等待）；TPS 用真实 output 配 `decodeMs`，旧 `speed`
 *     仅在**完全没有** `generationTiming` 的消息上作为已记录的 TPS 兼容，缺 decode
 *     时**不**回退 `durationMs`，也**不**用 `speed` 兜底（旧 `speedOf` 在无首内容时
 *     会拿 `startedAt` 造出 speed，否则无首内容的请求会凭空有 TPS）。工具用时取工具
 *     起止区间的**并集**（并行不重复计）。历史被截断时这些求和 / 比率只来自可见历史，
 *     有值也标部分。
 *   · TTFT 只把带 `startEvent: 'turn_start'`（原生请求准备起点）的值纳入平均；
 *     没有标记的 duration / ttft 是流下限，duration 计入但整体标下限（`modelPartial`
 *     呈 `≥`），ttft 直接排除。`decodeMs`（首内容 → 结束）与起点语义无关，照常可用。
 *   · 所有 usage / timing / 工具区间字段都过滤非有限值与负数；缺失一律 `null`，
 *     由界面显示 `—`，不编造。
 *
 * 纯函数、不依赖 React / Electron，可用 node 单测钉住
 * （见 `scripts/test-session-metrics.mjs`）。
 */
import type { SessionStats, UIMessage, Usage } from './ipc'
import { isSubagentNotice } from './subagent-notice'
import { addUsage, cacheHitRate, hasUsageNumbers, waitSpansMs } from './turns'

export interface SessionMetrics {
  /** 有模型回答的用户回合数 */
  turns: number
  /** 实际模型请求数（assistant 消息条数） */
  steps: number
  /** 会话累计输出速度（tok/s）；没有可用的计时图为 null */
  tps: number | null
  tpsPartial: boolean
  /** 模型生成用时（Σ 单次请求计时，ms）；未知 null */
  modelMs: number | null
  modelPartial: boolean
  /** 工具调用墙钟区间并集（ms）；历史缺起止为 null，部分为下限 */
  toolMs: number | null
  toolPartial: boolean
  /** 平均首 token 延迟（ms）；缺 `generationTiming.ttftMs` 时为 null */
  ttftMs: number | null
  ttftPartial: boolean
  /** 累计 Token 总数；未知 null */
  total: number | null
  /** 未缓存输入 */
  input: number | null
  output: number | null
  cacheRead: number | null
  /** 缓存写入；没有正数（服务没报或不支持）时为 null，界面据此隐藏该行 */
  cacheWrite: number | null
  hitRate: number | null
  /** 累计 Token / 花费是已知下限 → 界面标 `≥`，不把比率当求和 */
  partial: boolean
  /** 累计 Token 来自 pi 的会话统计还是消息求和 */
  source: 'stats' | 'messages' | 'none'
  /** 本会话花费；stats 未加载时为 null（界面显示 `—`，不当 0） */
  cost: number | null
  costEstimated: number
  /** 服务报 0 而会话已有 Token：花费不可信，界面应说明而不是当免费 */
  costZero: boolean
}

export interface SessionMetricsOptions {
  /**
   * 可见消息只是历史的一部分（切会话预览 / 长历史截断，UI 侧 `peekNote` 存在）。
   *
   * 为真时「逐条请求缺 usage」可能只是这条不在可见范围内，而不是服务没上报：
   * 归属受保护的 stats 是完整会话值时直接采信（不标下限）；
   * 没有这样的 stats 时，消息求和仍然只是下限。
   */
  historyPartial?: boolean
}

/** 只接受有限、非负的数值；其它（NaN / Infinity / 负数 / 非数字）按 0 处理。 */
function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/** 有限、非负的判定：区分「有这个计时」与「缺失」。 */
function isNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** 逐字段清掉非有限/负数再聚合，避免 Infinity 传出「精确的错误值」。 */
function sanitizeUsage(usage: Usage | undefined): Usage | undefined {
  if (!usage) return undefined
  return {
    input: nonNegative(usage.input),
    output: nonNegative(usage.output),
    cacheRead: nonNegative(usage.cacheRead),
    cacheWrite: nonNegative(usage.cacheWrite),
    totalTokens: nonNegative(usage.totalTokens),
    cost: nonNegative(usage.cost)
  }
}

/**
 * 剔除子代理通知与提问回答；同 id 重复时后者权威（补丁/终态覆盖旧值），
 * 但写回首次出现的位置，保证计数与排序稳定。
 */
function effectiveMessages(messages: readonly UIMessage[]): UIMessage[] {
  const indexById = new Map<string, number>()
  const out: UIMessage[] = []
  for (const m of messages) {
    if (!m || typeof m.id !== 'string') continue
    if (m.question) continue
    if (m.role === 'user' && isSubagentNotice(m.text)) continue
    const firstAt = indexById.get(m.id)
    if (firstAt !== undefined) {
      out[firstAt] = m
      continue
    }
    indexById.set(m.id, out.length)
    out.push(m)
  }
  return out
}

export function projectSessionMetrics(
  messages: readonly UIMessage[],
  stats: SessionStats | null | undefined,
  options?: SessionMetricsOptions
): SessionMetrics {
  const msgs = effectiveMessages(messages)
  const historyPartial = options?.historyPartial === true

  /* ── 回合 / 步数 ── */
  let turns = 0
  let steps = 0
  let pendingUser = false
  for (const m of msgs) {
    if (m.role === 'user') pendingUser = true
    else if (m.role === 'assistant') {
      steps += 1
      if (pendingUser) {
        turns += 1
        pendingUser = false
      }
    } else if (m.role === 'bash') {
      /* `!` 直执行是用户动作，不是模型回合；它终止「等待回答」 */
      pendingUser = false
    }
  }

  /* ── 消息求和的累计用量（逐条清洗，非有限/负数不计） ── */
  let derived: Usage | undefined
  let missingUsage = false
  let observedUsage = false
  for (const m of msgs) {
    if (m.role !== 'assistant') continue
    const usage = sanitizeUsage(m.usage)
    if (hasUsageNumbers(usage)) {
      derived = addUsage(derived, usage)
      observedUsage = true
    } else {
      missingUsage = true
    }
  }
  const derivedTotal = derived ? derived.input + derived.output + derived.cacheRead + derived.cacheWrite : 0
  const derivedPartial = observedUsage && missingUsage

  /*
   * stats 归属由 store 同步清空 + 运行时路由保证，不再用 `assistantMessages >
   * steps` 拒绝它 —— 可见消息可能只是被截断的长历史。只有 stats 总量明显落后于
   * 消息求和（更低）时才回退，并把「统计/花费可能部分」标出来。
   */
  const statsTokens = stats ? {
    input: nonNegative(stats.tokens.input),
    output: nonNegative(stats.tokens.output),
    cacheRead: nonNegative(stats.tokens.cacheRead),
    cacheWrite: nonNegative(stats.tokens.cacheWrite),
    total: nonNegative(stats.tokens.total)
  } : null
  const statsTotal = statsTokens ? statsTokens.total : 0
  const statsStale = !!statsTokens && statsTotal < derivedTotal

  let total: number | null = null
  let input: number | null = null
  let output: number | null = null
  let cacheRead: number | null = null
  let cacheWrite: number | null = null
  let partial = false
  let source: SessionMetrics['source'] = 'none'
  const statsReportsNothing = !!statsTokens && statsTotal === 0 && !observedUsage && steps > 0
  if (statsTokens && !statsStale && !statsReportsNothing) {
    total = statsTokens.total
    input = statsTokens.input
    output = statsTokens.output
    cacheRead = statsTokens.cacheRead
    cacheWrite = statsTokens.cacheWrite > 0 ? statsTokens.cacheWrite : null
    source = 'stats'
    /*
     * 「stats 有值」不等于「每个可见请求都报过」：可见请求缺 usage 时仍是下限，
     * 除非历史被截断、这份 stats 就是完整会话值。
     */
    partial = missingUsage && statsTotal > 0 && !historyPartial
  } else if (derived) {
    total = derivedTotal
    input = derived.input
    output = derived.output
    cacheRead = derived.cacheRead
    cacheWrite = derived.cacheWrite > 0 ? derived.cacheWrite : null
    source = 'messages'
    partial = derivedPartial || statsStale || historyPartial
  }
  const hitRate = total === null
    ? null
    : cacheHitRate({
        input: input ?? 0,
        output: output ?? 0,
        cacheRead: cacheRead ?? 0,
        cacheWrite: cacheWrite ?? 0,
        totalTokens: total,
        cost: 0
      })

  /* ── 计时：模型生成 / TTFT / TPS ── */
  let modelMs: number | null = null
  let modelMissing = 0
  let modelLowerBound = false
  let decodeOut = 0
  let decodeTime = 0
  let tpsCovered = 0
  let ttftSum = 0
  let ttftCount = 0
  for (const m of msgs) {
    if (m.role !== 'assistant') continue

    /*
     * 模型总用时只来自真实记录的单次请求时长；一点都没有就是缺失（包括没有 usage
     * 的请求），不用 speed 反推 —— speed 只覆盖解码段，补不出首包等待。
     * 没有 `startEvent: 'turn_start'` 标记（旧记录 / 回退起点）的 duration 只是
     * 流下限，标为下限（界面呈 ≥），不冒充完整请求时长。
     */
    const gt = m.generationTiming
    const marked = gt?.startEvent === 'turn_start'
    const durationMs = gt && isNonNegative(gt.durationMs) ? gt.durationMs : null
    if (durationMs === null) modelMissing += 1
    else {
      modelMs = (modelMs ?? 0) + durationMs
      if (!marked) modelLowerBound = true
    }

    /*
     * TPS 只把「真实 output」配上「真实解码时间」：优先 generationTiming.decodeMs，
     * 旧消息里的 speed 作为已记录的 TPS 兼容。没有首内容时 gt 只给 durationMs，
     * 绝不用它冒充解码，否则会把等待首包也算进生成速度。
     */
    const usage = sanitizeUsage(m.usage)
    const out = usage ? usage.output : 0
    const realDecode = gt && isNonNegative(gt.decodeMs) && gt.decodeMs > 0 ? gt.decodeMs : null
    /*
     * 旧 speed 只在**完全没有** generationTiming 时才兼容：有 gt 却没有/非法 decodeMs
     * 说明这次请求没记录解码段（旧 speedOf 在无首内容时会拿 startedAt 造出 speed），
     * 此时不能拿 speed 兜底，否则无首内容的请求会凭空多出 TPS。
     */
    const legacySpeed = gt === undefined && isNonNegative(m.speed) && m.speed > 0 ? m.speed : null
    const decodeMs = realDecode ?? (legacySpeed !== null && out > 0 ? (out / legacySpeed) * 1000 : null)
    if (out > 0 && decodeMs !== null) {
      decodeOut += out
      decodeTime += decodeMs
      tpsCovered += 1
    }

    /*
     * TTFT 只认带 `turn_start` 标记的值：无标记的起点是流下限，不含请求准备与
     * 网络等待，拿它平均会低估首包延迟；旧记录（没有 startEvent）一律排除。
     */
    const ttft = gt && gt.startEvent === 'turn_start' && isNonNegative(gt.ttftMs) ? gt.ttftMs : null
    if (ttft !== null) {
      ttftSum += ttft
      ttftCount += 1
    }
  }
  const tps = decodeTime > 0 ? decodeOut / (decodeTime / 1000) : null
  /*
   * 比率只给「已记录部分」的值，不能像求和那样标 `≥`；完整性一律按实际 steps 算。
   * 历史截断时计时也只来自可见历史 → 即使都记过也只是可见部分的下限。
   */
  const tpsPartial = (steps > 0 && tpsCovered < steps) || (historyPartial && tps !== null)
  const modelPartial =
    (modelMs !== null && (modelMissing > 0 || modelLowerBound)) || (historyPartial && modelMs !== null)
  const ttftMs = ttftCount > 0 ? ttftSum / ttftCount : null
  const ttftPartial = (ttftCount > 0 && ttftCount < steps) || (historyPartial && ttftMs !== null)

  /* ── 工具调用用时：区间并集 ── */
  const toolIds = new Set<string>()
  const spans: { id: string; name: string; startedAt: number; endedAt: number }[] = []
  let toolTotal = 0
  for (const m of msgs) {
    for (const c of m.toolCalls ?? []) {
      if (!c || typeof c.id !== 'string' || toolIds.has(c.id)) continue
      toolIds.add(c.id)
      toolTotal += 1
      if (isNonNegative(c.startedAt) && isNonNegative(c.endedAt) && c.endedAt >= c.startedAt) {
        spans.push({ id: c.id, name: c.name, startedAt: c.startedAt, endedAt: c.endedAt })
      }
    }
  }
  let toolMs: number | null
  let toolPartial = false
  if (toolTotal === 0) toolMs = 0
  else if (spans.length === 0) toolMs = null
  else {
    toolMs = waitSpansMs(spans)
    toolPartial = spans.length < toolTotal
  }
  /* 历史截断时工具区间也只来自可见消息 → 有值即是可见部分的下限。 */
  if (historyPartial && toolMs !== null) toolPartial = true

  /* ── 花费：只认 stats，未加载时留 null（不当 0）；落后于消息时由 partial 提示 ── */
  const cost = stats ? nonNegative(stats.cost) : null
  const costEstimated = stats ? nonNegative(stats.costEstimated) : 0
  const costZero = cost === 0 && total !== null && total > 0

  return {
    turns,
    steps,
    tps,
    tpsPartial,
    modelMs,
    modelPartial,
    toolMs,
    toolPartial,
    ttftMs,
    ttftPartial,
    total,
    input,
    output,
    cacheRead,
    cacheWrite,
    hitRate,
    partial,
    source,
    cost,
    costEstimated,
    costZero
  }
}
