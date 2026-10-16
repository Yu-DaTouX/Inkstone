import type { SessionStats, SessionState, UIMessage } from '../../../../shared/ipc'
import { contextBreakdown, type ContextSlice } from '../../state/context-breakdown'

const IMAGE_TOKENS = 1200

export interface ContextUsageSummary {
  known: boolean
  tokens: number
  windowSize: number
  percent: number | null
  tone: 'ok' | 'warn' | 'err'
  matchesModel: boolean
  afterCompactUnknown: boolean
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
  since?: number
}

export function contextUsageSummary(
  session: Pick<SessionState, 'model' | 'lastCompaction'> | null,
  stats: Pick<SessionStats, 'contextUsage'> | null
): ContextUsageSummary {
  const usage = stats?.contextUsage
  const modelKey = session?.model ? `${session.model.provider}/${session.model.id}` : undefined
  const matchesModel = !!usage && (!usage.modelKey || usage.modelKey === modelKey)
  const reported = matchesModel ? usage?.contextWindow : undefined
  const windowSize =
    typeof reported === 'number' && Number.isFinite(reported) && reported > 0
      ? reported
      : session?.model?.contextWindow ?? 0
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
    afterCompactUnknown: matchesModel && usage?.tokens === null
  }
}

export function contextSince(session: Pick<SessionState, 'lastCompaction'> | null): number | undefined {
  return session?.lastCompaction?.status === 'completed' ? session.lastCompaction.startedAt : undefined
}

export function shortTokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`
  if (n >= 1000) return `${+(n / 1000).toFixed(1)}k`
  return String(n)
}

export function contextOccupancy(
  messages: readonly UIMessage[],
  slices: readonly ContextSlice[],
  since?: number
): ContextOccupancyRow[] {
  let toolCount = 0
  let fileCount = 0
  for (const m of messages) {
    if (since && (m.timestamp ?? 0) < since) continue
    if (m.role === 'user') fileCount += m.images?.length ?? 0
    toolCount += m.toolCalls?.length ?? 0
  }
  const tools = slices.find((s) => s.id === 'tools')?.tokens ?? 0
  return [
    { id: 'tools', tokens: tools, count: toolCount },
    { id: 'files', tokens: fileCount * IMAGE_TOKENS, count: fileCount }
  ]
}

export function contextPaneData(input: {
  session: Pick<SessionState, 'model' | 'lastCompaction'> | null
  stats: Pick<SessionStats, 'contextUsage'> | null
  messages: readonly UIMessage[]
}): ContextPaneData {
  const usage = contextUsageSummary(input.session, input.stats)
  const since = contextSince(input.session)
  if (!usage.known) return { usage, slices: [], occupancy: [], since }
  const slices = contextBreakdown(input.messages, usage.tokens, since)
  return { usage, slices, occupancy: contextOccupancy(input.messages, slices, since), since }
}
