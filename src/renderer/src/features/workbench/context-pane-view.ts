import type { SessionStats, SessionState, UIMessage } from '../../../../shared/ipc'
import { DEFAULT_AUTO_COMPACT_TOKENS, autoCompactAt } from '../../../../shared/context-limits'
import {
  bashMessageTokens,
  contextBreakdown,
  contextFromOf,
  inContextMessages,
  modelVisibleToolCalls,
  toolCallTokens,
  type ContextSlice
} from '../../state/context-breakdown'
import { redactCommandSecrets, toolTarget } from '../session/tool-title'

const TOP_TOOL_CALLS = 8

export interface ContextUsageSummary {
  known: boolean
  tokens: number
  windowSize: number
  percent: number | null
  tone: 'ok' | 'ask' | 'fail'
  matchesModel: boolean
  afterCompactUnknown: boolean
  windowAssumed: boolean
  modelWindow: number
  cappedByLimit: boolean
}

export interface ContextToolCall {
  id: string
  anchorId: string
  name: string
  target: string
  tokens: number
}

export interface AutoCompactDistance {
  kind: 'off' | 'window' | 'limit' | 'reached'
  remaining: number
}

export interface ContextPaneData {
  usage: ContextUsageSummary
  slices: ContextSlice[]
  compacted: boolean
}

interface ContextPaneInput {
  session: Pick<SessionState, 'model' | 'lastCompaction' | 'contextFrom' | 'isStreaming' | 'isAgentRunning'> | null
  stats: Pick<SessionStats, 'contextUsage'> | null
  messages: readonly UIMessage[]
  autoCompactLimit?: number
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
  const known = matchesModel && typeof usage?.tokens === 'number' && windowSize > 0
  const tokens = known ? (usage!.tokens as number) : 0
  const percent = known ? (tokens / windowSize) * 100 : null
  const tone: 'ok' | 'ask' | 'fail' =
    percent !== null && percent >= 95 ? 'fail' : percent !== null && percent >= 80 ? 'ask' : 'ok'
  return {
    known,
    tokens,
    windowSize,
    percent,
    tone,
    matchesModel,
    afterCompactUnknown: matchesModel && usage?.tokens === null,
    windowAssumed: !cappedByLimit && !!session?.model?.contextWindowAssumed && windowSize === session.model.contextWindow,
    modelWindow,
    cappedByLimit
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
  const remaining = Math.max(0, usage.windowSize - usage.tokens)
  if (!usage.cappedByLimit) return { kind: 'window', remaining }
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
      if (tokens > 0) rows.push({ id: call.id, anchorId, name: call.name, target: firstLine(toolTarget(call)), tokens })
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
  if (!range) return { usage, slices: [], compacted }
  return { usage, slices: contextBreakdown(range.inContext, usage.tokens), compacted }
}

export function contextPaneToolCalls(input: ContextPaneInput, limit = TOP_TOOL_CALLS): ContextToolCall[] {
  const range = contextRange(input, contextUsageSummary(input.session, input.stats, input.autoCompactLimit))
  return range ? largestToolCalls(range.settled, range.inContext, limit) : []
}
