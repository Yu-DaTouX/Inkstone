import { cacheHitRate } from './turns'

export type ContextBackgroundCallKind = 'summary' | 'deep' | 'state' | 'handoff' | 'title'

export const CONTEXT_BACKGROUND_CALL_KINDS: ContextBackgroundCallKind[] = [
  'summary',
  'deep',
  'state',
  'handoff',
  'title'
]

export interface ContextBackgroundCallRecord {
  at: number
  kind: ContextBackgroundCallKind
  ok: boolean
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: number
  estimatedInput?: number
  durationMs?: number
  model?: string
  error?: string
  usageReported: boolean
}

export interface ContextBackgroundKindSummary {
  kind: ContextBackgroundCallKind
  calls: number
  failed: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: number
  estimatedInput: number
  missingUsage: number
  lastAt: number | null
  lastError: string | null
}

export interface ContextBackgroundUsageSummary {
  kinds: ContextBackgroundKindSummary[]
  calls: number
  failed: number
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  totalTokens: number
  cost: number
  estimatedInput: number
  cacheHitRate: number | null
  missingUsage: number
  lastAt: number | null
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function emptyKind(kind: ContextBackgroundCallKind): ContextBackgroundKindSummary {
  return {
    kind,
    calls: 0,
    failed: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: 0,
    estimatedInput: 0,
    missingUsage: 0,
    lastAt: null,
    lastError: null
  }
}

export function parseBackgroundUsageLines(text: string, limit = 500): ContextBackgroundCallRecord[] {
  const out: ContextBackgroundCallRecord[] = []
  for (const line of String(text ?? '').split('\n')) {
    const raw = line.trim()
    if (!raw) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object') continue
    const item = parsed as Record<string, unknown>
    const kind = item.kind
    if (typeof kind !== 'string' || !(CONTEXT_BACKGROUND_CALL_KINDS as string[]).includes(kind)) continue
    const record: ContextBackgroundCallRecord = {
      at: num(item.at),
      kind: kind as ContextBackgroundCallKind,
      ok: item.ok === true,
      input: num(item.input),
      output: num(item.output),
      cacheRead: num(item.cacheRead),
      cacheWrite: num(item.cacheWrite),
      totalTokens: num(item.totalTokens),
      cost: num(item.cost),
      usageReported: item.usageReported !== false
    }
    if (typeof item.estimatedInput === 'number' && Number.isFinite(item.estimatedInput) && item.estimatedInput >= 0) {
      record.estimatedInput = item.estimatedInput
    }
    if (typeof item.durationMs === 'number' && Number.isFinite(item.durationMs) && item.durationMs >= 0) {
      record.durationMs = item.durationMs
    }
    if (typeof item.model === 'string' && item.model) record.model = item.model.slice(0, 200)
    if (typeof item.error === 'string' && item.error) record.error = item.error.slice(0, 300)
    out.push(record)
  }
  return limit > 0 && out.length > limit ? out.slice(-limit) : out
}

export function summarizeBackgroundUsage(records: ContextBackgroundCallRecord[]): ContextBackgroundUsageSummary {
  const kinds = CONTEXT_BACKGROUND_CALL_KINDS.map(emptyKind)
  const byKind = new Map(kinds.map((item) => [item.kind, item]))
  let input = 0
  let cacheRead = 0
  let cacheWrite = 0
  let output = 0
  let totalTokens = 0
  let cost = 0
  let estimatedInput = 0
  let failed = 0
  let missingUsage = 0
  let lastAt: number | null = null

  for (const record of records) {
    const summary = byKind.get(record.kind)
    if (summary) {
      summary.calls += 1
      if (!record.ok) {
        summary.failed += 1
        if (record.error) summary.lastError = record.error
      }
      summary.input += record.input
      summary.output += record.output
      summary.cacheRead += record.cacheRead
      summary.cacheWrite += record.cacheWrite
      summary.totalTokens += record.totalTokens
      summary.cost += record.cost
      summary.estimatedInput += record.estimatedInput ?? 0
      if (!record.usageReported) summary.missingUsage += 1
      if (summary.lastAt === null || record.at >= summary.lastAt) summary.lastAt = record.at
    }
    if (!record.ok) failed += 1
    if (!record.usageReported) missingUsage += 1
    input += record.input
    output += record.output
    cacheRead += record.cacheRead
    cacheWrite += record.cacheWrite
    totalTokens += record.totalTokens
    cost += record.cost
    estimatedInput += record.estimatedInput ?? 0
    if (lastAt === null || record.at > lastAt) lastAt = record.at
  }

  return {
    kinds,
    calls: records.length,
    failed,
    input,
    cacheRead,
    cacheWrite,
    output,
    totalTokens,
    cost,
    estimatedInput,
    cacheHitRate: cacheHitRate({ input, output, cacheRead, cacheWrite, totalTokens, cost }),
    missingUsage,
    lastAt
  }
}

export function emptyBackgroundUsage(): ContextBackgroundUsageSummary {
  return summarizeBackgroundUsage([])
}
