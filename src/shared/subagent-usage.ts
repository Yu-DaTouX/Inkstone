import type { SessionStats, SubagentUsageTotals, Usage } from './ipc'

export type { SubagentUsageTotals }

export function normalizeSubagentContextUsage(value: unknown): SessionStats['contextUsage'] {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const tokens = typeof raw.tokens === 'number' && Number.isFinite(raw.tokens) && raw.tokens >= 0 ? raw.tokens : null
  const contextWindow = typeof raw.contextWindow === 'number' && Number.isFinite(raw.contextWindow) && raw.contextWindow > 0 ? raw.contextWindow : 0
  if (tokens === null && contextWindow === 0) return undefined
  return {
    tokens,
    contextWindow,
    percent: tokens !== null && contextWindow > 0 ? tokens / contextWindow * 100 : null,
    availability: tokens === null ? 'unknown' : 'known',
    estimated: false
  }
}

export type UsageSnapshots = Record<string, Usage>

export function ingestUsageSnapshot(
  snapshots: UsageSnapshots,
  messageId: string,
  usage: Usage
): UsageSnapshots {
  if (!messageId) return snapshots
  return { ...snapshots, [messageId]: usage }
}

const EMPTY: SubagentUsageTotals = {
  input: null,
  output: null,
  cacheRead: null,
  cacheWrite: null,
  totalTokens: null,
  cost: null,
  reportedMessages: 0
}

export function accumulateUsage(snapshots: UsageSnapshots): SubagentUsageTotals {
  const entries = Object.values(snapshots)
  if (entries.length === 0) return { ...EMPTY }
  let input = 0
  let output = 0
  let cacheRead = 0
  let cacheWrite = 0
  let totalTokens = 0
  let cost = 0
  for (const u of entries) {
    input += u.input
    output += u.output
    cacheRead += u.cacheRead
    cacheWrite += u.cacheWrite
    totalTokens += u.totalTokens
    cost += u.cost
  }
  return { input, output, cacheRead, cacheWrite, totalTokens, cost, reportedMessages: entries.length }
}

export function normalizeSubagentUsage(value: unknown): SubagentUsageTotals | undefined {
  if (!value || typeof value !== 'object') return undefined
  const input = value as Partial<SubagentUsageTotals>
  if (typeof input.reportedMessages !== 'number' || input.reportedMessages <= 0) return undefined
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return {
    input: num(input.input),
    output: num(input.output),
    cacheRead: num(input.cacheRead),
    cacheWrite: num(input.cacheWrite),
    totalTokens: num(input.totalTokens),
    cost: num(input.cost),
    reportedMessages: input.reportedMessages
  }
}
