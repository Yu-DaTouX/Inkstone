import type { SessionStats, UIMessage, Usage } from './ipc'
import { isSubagentNotice } from './subagent-notice'
import { addUsage, cacheHitRate, hasUsageNumbers, waitSpansMs } from './turns'

export interface SessionMetrics {
  turns: number
  steps: number
  tps: number | null
  tpsPartial: boolean
  modelMs: number | null
  modelPartial: boolean
  toolMs: number | null
  toolPartial: boolean
  ttftMs: number | null
  ttftPartial: boolean
  total: number | null
  input: number | null
  output: number | null
  cacheRead: number | null
  cacheWrite: number | null
  hitRate: number | null
  partial: boolean
  source: 'stats' | 'messages' | 'none'
  cost: number | null
  costEstimated: number
  costZero: boolean
}

export interface SessionMetricsOptions {
  historyPartial?: boolean
}

function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function isNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

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
      pendingUser = false
    }
  }

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

    const gt = m.generationTiming
    const marked = gt?.startEvent === 'turn_start'
    const durationMs = gt && isNonNegative(gt.durationMs) ? gt.durationMs : null
    if (durationMs === null) modelMissing += 1
    else {
      modelMs = (modelMs ?? 0) + durationMs
      if (!marked) modelLowerBound = true
    }

    const usage = sanitizeUsage(m.usage)
    const out = usage ? usage.output : 0
    const realDecode = gt && isNonNegative(gt.decodeMs) && gt.decodeMs > 0 ? gt.decodeMs : null
    const legacySpeed = gt === undefined && isNonNegative(m.speed) && m.speed > 0 ? m.speed : null
    const decodeMs = realDecode ?? (legacySpeed !== null && out > 0 ? (out / legacySpeed) * 1000 : null)
    if (out > 0 && decodeMs !== null) {
      decodeOut += out
      decodeTime += decodeMs
      tpsCovered += 1
    }

    const ttft = gt && gt.startEvent === 'turn_start' && isNonNegative(gt.ttftMs) ? gt.ttftMs : null
    if (ttft !== null) {
      ttftSum += ttft
      ttftCount += 1
    }
  }
  const tps = decodeTime > 0 ? decodeOut / (decodeTime / 1000) : null
  const tpsPartial = (steps > 0 && tpsCovered < steps) || (historyPartial && tps !== null)
  const modelPartial =
    (modelMs !== null && (modelMissing > 0 || modelLowerBound)) || (historyPartial && modelMs !== null)
  const ttftMs = ttftCount > 0 ? ttftSum / ttftCount : null
  const ttftPartial = (ttftCount > 0 && ttftCount < steps) || (historyPartial && ttftMs !== null)

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
  if (historyPartial && toolMs !== null) toolPartial = true

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
