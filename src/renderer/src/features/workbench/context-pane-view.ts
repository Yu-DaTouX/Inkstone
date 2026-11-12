import type { SessionStats, SessionState, UIMessage } from '../../../../shared/ipc'
import { DEFAULT_AUTO_COMPACT_TOKENS, autoCompactAt } from '../../../../shared/context-limits'
import {
  bashMessageTokens,
  contextBreakdown,
  contextFromOf,
  inContextMessages,
  measuredSystemTokens,
  modelVisibleToolCalls,
  toolCallTokens,
  type ContextSlice
} from '../../state/context-breakdown'
import { redactCommandSecrets, stepDescription, toolTarget } from '../session/tool-title'
import { splitSystem, sourcesTotal, type ContextSources, type SystemPartId } from '../../state/context-sources'

const TOP_TOOL_CALLS = 8

export interface ContextUsageSummary {
  known: boolean
  estimated: boolean
  tokens: number
  windowSize: number
  percent: number | null
  tone: 'ok' | 'ask' | 'fail'
  matchesModel: boolean
  afterCompactUnknown: boolean
  windowAssumed: boolean
  modelWindow: number
  cappedByLimit: boolean
  compactAt: number | null
}

export interface ContextToolCall {
  id: string
  anchorId: string
  name: string
  target: string
  detail?: string
  scriptLines?: number
  tokens: number
}

export interface AutoCompactDistance {
  kind: 'off' | 'window' | 'limit' | 'reached'
  remaining: number
}

export type ContextPartId = ContextSlice['id'] | SystemPartId | 'summary'
export interface ContextPart { id: ContextPartId; tokens: number; approx?: boolean }

export interface ContextPaneData {
  usage: ContextUsageSummary
  slices: ContextSlice[]
  parts: ContextPart[]
  compacted: boolean
  sources: ContextSources | null
}

interface ContextPaneInput {
  session: Pick<SessionState, 'model' | 'lastCompaction' | 'contextFrom' | 'isStreaming' | 'isAgentRunning'> | null
  stats: Pick<SessionStats, 'contextUsage'> | null
  messages: readonly UIMessage[]
  autoCompactLimit?: number
  summaryTokens?: number
  sources?: ContextSources | null
}

export function autoCompactLimitOf(
  session: Pick<SessionState, 'autoCompactionEnabled'> | null,
  settings: { autoCompactTokens?: number } | null | undefined
): number | undefined {
  return session?.autoCompactionEnabled ? settings?.autoCompactTokens ?? DEFAULT_AUTO_COMPACT_TOKENS : undefined
}

export function contextUsageSummary(
  session: Pick<SessionState, 'model' | 'lastCompaction'> | null,
  stats: Pick<SessionStats, 'contextUsage'> | null,
  autoCompactLimit?: number
): ContextUsageSummary {
  const usage = stats?.contextUsage
  const modelKey = session?.model ? `${session.model.provider}/${session.model.id}` : undefined
  const matchesModel = !!usage && (!usage.modelKey || usage.modelKey === modelKey)
  const reported = matchesModel ? usage?.contextWindow : undefined
  const modelWindow =
    typeof reported === 'number' && Number.isFinite(reported) && reported > 0
      ? reported
      : session?.model?.contextWindow ?? 0
  const cappedByLimit = !!autoCompactLimit && modelWindow > 0 && autoCompactLimit < modelWindow
  const windowSize = cappedByLimit ? autoCompactAt(autoCompactLimit, modelWindow) : modelWindow
  const measuredTokens = matchesModel && typeof usage?.tokens === 'number' ? usage.tokens : undefined
  const last = session?.lastCompaction
  const afterTokens = matchesModel && usage?.tokens === null && last?.status === 'completed' && !last.afterMeasured
    ? last.afterTokens
    : undefined
  const estimate = typeof afterTokens === 'number' && Number.isFinite(afterTokens) && afterTokens >= 0 ? afterTokens : undefined
  const value = measuredTokens ?? estimate
  const known = value !== undefined && windowSize > 0
  const tokens = known ? value : 0
  const estimated = known && (measuredTokens === undefined || usage?.estimated === true)
  const percent = known ? (tokens / windowSize) * 100 : null
  const tone: 'ok' | 'ask' | 'fail' =
    percent !== null && percent >= 95 ? 'fail' : percent !== null && percent >= 80 ? 'ask' : 'ok'
  return {
    known,
    estimated,
    tokens,
    windowSize,
    percent,
    tone,
    matchesModel,
    afterCompactUnknown: matchesModel && usage?.tokens === null && !known,
    windowAssumed: !cappedByLimit && !!session?.model?.contextWindowAssumed && windowSize === session.model.contextWindow,
    modelWindow,
    cappedByLimit,
    compactAt: autoCompactLimit && modelWindow > 0 ? autoCompactAt(autoCompactLimit, modelWindow) : null
  }
}

export function shortTokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`
  if (n >= 1000) return `${+(n / 1000).toFixed(1)}k`
  return String(n)
}

export function autoCompactDistance(
  usage: ContextUsageSummary,
  autoCompactionEnabled: boolean | undefined
): AutoCompactDistance | null {
  if (!usage.known || autoCompactionEnabled === undefined) return null
  if (!autoCompactionEnabled) return { kind: 'off', remaining: Math.max(0, usage.modelWindow - usage.tokens) }
  if (usage.compactAt === null) return { kind: 'window', remaining: Math.max(0, usage.windowSize - usage.tokens) }
  const remaining = Math.max(0, usage.compactAt - usage.tokens)
  return { kind: remaining > 0 ? 'limit' : 'reached', remaining }
}

function settledMessages(
  session: Pick<SessionState, 'isStreaming' | 'isAgentRunning'> | null,
  messages: readonly UIMessage[]
): readonly UIMessage[] {
  const running = !!session?.isStreaming || !!session?.isAgentRunning
  return running && messages[messages.length - 1]?.role === 'assistant' ? messages.slice(0, -1) : messages
}

export function turnAnchorIds(messages: readonly UIMessage[]): Map<string, string> {
  const anchors = new Map<string, string>()
  let turnStart: string | null = null
  for (const m of messages) {
    if (m.role === 'assistant') {
      turnStart ??= m.id
      anchors.set(m.id, turnStart)
    } else {
      turnStart = null
      anchors.set(m.id, m.id)
    }
  }
  return anchors
}

function firstLine(text: string): string {
  return text.split('\n').map((line) => line.trim()).find(Boolean) ?? ''
}

function toolCallRow(call: Parameters<typeof toolTarget>[0]): Pick<ContextToolCall, 'target' | 'detail' | 'scriptLines'> {
  const code = (call.args as { code?: unknown } | undefined)?.code
  if (typeof code !== 'string') return { target: firstLine(toolTarget(call)) }
  const lines = code.split('\n').filter((line) => line.trim()).length
  return { target: stepDescription(call), detail: redactCommandSecrets(firstLine(code)), scriptLines: lines }
}

export function largestToolCalls(
  messages: readonly UIMessage[],
  inContext: readonly UIMessage[],
  limit = TOP_TOOL_CALLS
): ContextToolCall[] {
  const anchors = turnAnchorIds(messages)
  const rows: ContextToolCall[] = []
  for (const m of inContext) {
    const anchorId = anchors.get(m.id) ?? m.id
    if (m.role === 'bash') {
      const tokens = bashMessageTokens(m)
      if (tokens > 0) rows.push({ id: m.id, anchorId, name: 'bash', target: firstLine(redactCommandSecrets(m.bash?.command ?? '')), tokens })
      continue
    }
    if (m.role !== 'assistant') continue
    for (const call of modelVisibleToolCalls(m)) {
      const tokens = toolCallTokens(call)
      if (tokens > 0) rows.push({ id: call.id, anchorId, name: call.name, ...toolCallRow(call), tokens })
    }
  }
  return rows.sort((a, b) => b.tokens - a.tokens).slice(0, Math.max(0, limit))
}

function contextRange(input: ContextPaneInput, usage: ContextUsageSummary): { settled: readonly UIMessage[]; inContext: readonly UIMessage[] } | null {
  if (!usage.known) return null
  const settled = settledMessages(input.session, input.messages)
  return { settled, inContext: inContextMessages(settled, contextFromOf(input.session)) }
}

export function contextPaneData(input: ContextPaneInput): ContextPaneData {
  const usage = contextUsageSummary(input.session, input.stats, input.autoCompactLimit)
  const compacted = !!contextFromOf(input.session)
  const range = contextRange(input, usage)
  const sources = input.sources ?? null
  if (!range) return { usage, slices: [], parts: [], compacted, sources }
  const measured = measuredSystemTokens(range.settled)
  const system = measured > 0 ? measured : sourcesTotal(sources)
  const floor = system > 0 && compacted ? system + Math.max(0, input.summaryTokens ?? 0) : system
  const slices = contextBreakdown(range.inContext, usage.tokens, floor)
  return { usage, slices, parts: contextParts(slices, sources, compacted, usage.estimated || measured <= 0), compacted, sources }
}

export function contextParts(slices: readonly ContextSlice[], sources: ContextSources | null, compacted: boolean, approx: boolean): ContextPart[] {
  return slices.flatMap((slice): ContextPart[] => {
    if (slice.id !== 'system') return [slice]
    const split = splitSystem(slice.tokens, sources, compacted)
    return split ? split.map((part) => (approx ? { ...part, approx } : part)) : [slice]
  })
}

export interface ContextReserve { buffer: number | null; free: number }

export function contextReserve(usage: ContextUsageSummary): ContextReserve {
  if (usage.compactAt === null) return { buffer: null, free: Math.max(0, usage.windowSize - usage.tokens) }
  const line = Math.min(usage.compactAt, usage.windowSize)
  return {
    buffer: Math.max(0, usage.windowSize - Math.max(line, usage.tokens)),
    free: Math.max(0, line - usage.tokens)
  }
}

export function contextPaneToolCalls(input: ContextPaneInput, limit = TOP_TOOL_CALLS): ContextToolCall[] {
  const range = contextRange(input, contextUsageSummary(input.session, input.stats, input.autoCompactLimit))
  return range ? largestToolCalls(range.settled, range.inContext, limit) : []
}
