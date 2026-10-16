export type ContextActionKind = 'tool-sweep' | 'episode-fold' | 'compaction'

export const RECORDED_ACTION_KINDS: ContextActionKind[] = ['tool-sweep', 'episode-fold']

export const CONTEXT_ACTION_KINDS: ContextActionKind[] = ['tool-sweep', 'episode-fold', 'compaction']

export interface ContextActionRecord {
  at: number
  kind: ContextActionKind
  status: string
  reason?: string
  reclaimed?: number
  savedTokens?: number
  tokens?: number
  freshness?: string
}

export interface ContextActionKindSummary {
  kind: ContextActionKind
  count: number
  applied: number
  skipped: number
  lastAt: number | null
  lastStatus: string | null
  lastReason: string | null
  reclaimed: number
  savedTokens: number
}

export interface ContextActionSummary {
  kinds: ContextActionKindSummary[]
  total: number
  lastAt: number | null
}

function emptyKind(kind: ContextActionKind): ContextActionKindSummary {
  return {
    kind,
    count: 0,
    applied: 0,
    skipped: 0,
    lastAt: null,
    lastStatus: null,
    lastReason: null,
    reclaimed: 0,
    savedTokens: 0
  }
}

export function parseActionLines(text: string, limit = 300): ContextActionRecord[] {
  const out: ContextActionRecord[] = []
  const lines = String(text ?? '').split('\n')
  for (const line of lines) {
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
    if (typeof kind !== 'string' || !(CONTEXT_ACTION_KINDS as string[]).includes(kind)) continue
    const at = typeof item.at === 'number' && Number.isFinite(item.at) ? item.at : 0
    const status = typeof item.status === 'string' && item.status ? item.status : 'unknown'
    const record: ContextActionRecord = { at, kind: kind as ContextActionKind, status }
    if (typeof item.reason === 'string' && item.reason) record.reason = item.reason
    if (typeof item.reclaimed === 'number' && Number.isFinite(item.reclaimed)) record.reclaimed = item.reclaimed
    if (typeof item.savedTokens === 'number' && Number.isFinite(item.savedTokens)) record.savedTokens = item.savedTokens
    if (typeof item.tokens === 'number' && Number.isFinite(item.tokens)) record.tokens = item.tokens
    if (typeof item.freshness === 'string' && item.freshness) record.freshness = item.freshness
    out.push(record)
  }
  return limit > 0 && out.length > limit ? out.slice(-limit) : out
}

export function summarizeActions(records: ContextActionRecord[]): ContextActionSummary {
  const kinds = RECORDED_ACTION_KINDS.map(emptyKind)
  const byKind = new Map(kinds.map((item) => [item.kind, item]))
  const reasonAt: Record<string, number> = {}
  let lastAt: number | null = null

  for (const record of records) {
    const summary = byKind.get(record.kind)
    if (!summary) continue
    summary.count += 1
    if (record.status === 'applied' || record.status === 'injected') summary.applied += 1
    if (record.status === 'skipped' || record.status === 'rejected') summary.skipped += 1
    if (typeof record.reclaimed === 'number') summary.reclaimed += record.reclaimed
    if (typeof record.savedTokens === 'number') summary.savedTokens += record.savedTokens
    if (summary.lastAt === null || record.at >= summary.lastAt) {
      summary.lastAt = record.at
      summary.lastStatus = record.status
    }
    if (record.reason && (reasonAt[record.kind] === undefined || record.at >= reasonAt[record.kind])) {
      summary.lastReason = record.reason
      reasonAt[record.kind] = record.at
    }
    if (lastAt === null || record.at > lastAt) lastAt = record.at
  }

  return { kinds, total: records.length, lastAt }
}
