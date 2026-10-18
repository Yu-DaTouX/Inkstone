import type { SessionStats, SessionState, UIMessage } from '../../../../shared/ipc'
import { DEFAULT_AUTO_COMPACT_TOKENS, autoCompactAt } from '../../../../shared/context-limits'
import { contextBreakdown, contextFromOf, inContextMessages, type ContextSlice } from '../../state/context-breakdown'

const IMAGE_TOKENS = 1200

export interface ContextUsageSummary {
  known: boolean
  tokens: number
  windowSize: number
  percent: number | null
  tone: 'ok' | 'warn' | 'err'
  matchesModel: boolean
  afterCompactUnknown: boolean
  windowAssumed: boolean
  modelWindow: number
  cappedByLimit: boolean
}

export interface ContextOccupancyRow {
  id: 'tools' | 'files'
  tokens: number
  count: number
}

export interface ContextPaneData {
  usage: ContextUsageSummary
  slices: ContextSlice[]
  occupancy: ContextOccupancyRow[]
  compacted: boolean
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
  const tone: 'ok' | 'warn' | 'err' =
    percent !== null && percent >= 95 ? 'err' : percent !== null && percent >= 80 ? 'warn' : 'ok'
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

export function contextOccupancy(
  messages: readonly UIMessage[],
  slices: readonly ContextSlice[]
): ContextOccupancyRow[] {
  let toolCount = 0
  let fileCount = 0
  for (const m of messages) {
    if (m.role === 'user') fileCount += m.images?.length ?? 0
    toolCount += m.toolCalls?.length ?? 0
  }
  const tools = slices.find((s) => s.id === 'tools')?.tokens ?? 0
  return [
    { id: 'tools', tokens: tools, count: toolCount },
    { id: 'files', tokens: fileCount * IMAGE_TOKENS, count: fileCount }
  ]
}

function settledMessages(
  session: Pick<SessionState, 'isStreaming' | 'isAgentRunning'> | null,
  messages: readonly UIMessage[]
): readonly UIMessage[] {
  const running = !!session?.isStreaming || !!session?.isAgentRunning
  return running && messages[messages.length - 1]?.role === 'assistant' ? messages.slice(0, -1) : messages
}

export function contextPaneData(input: {
  session: Pick<SessionState, 'model' | 'lastCompaction' | 'contextFrom' | 'isStreaming' | 'isAgentRunning'> | null
  stats: Pick<SessionStats, 'contextUsage'> | null
  messages: readonly UIMessage[]
  autoCompactLimit?: number
}): ContextPaneData {
  const usage = contextUsageSummary(input.session, input.stats, input.autoCompactLimit)
  const from = contextFromOf(input.session)
  const compacted = !!from
  if (!usage.known) return { usage, slices: [], occupancy: [], compacted }
  const messages = inContextMessages(settledMessages(input.session, input.messages), from)
  const slices = contextBreakdown(messages, usage.tokens)
  return { usage, slices, occupancy: contextOccupancy(messages, slices), compacted }
}
