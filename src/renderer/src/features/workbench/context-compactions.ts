import type { NativeSessionHostRequest, NativeSessionHostResult } from '../../../../shared/native-session-host'
import { estimateTokens } from '../../state/context-breakdown'

export interface CompactionHistoryItem {
  id: string
  at?: number
  tokensBefore?: number
  tokensAfter?: number
  summaryTokens: number
}

export type CompactionHistoryLoad =
  | { ok: true; items: CompactionHistoryItem[] }
  | { ok: false; error: string }

type Entry = Record<string, unknown>

function recordOf(value: unknown): Entry | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Entry) : null
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function timestampOf(entry: Entry): number | undefined {
  const raw = entry.timestamp
  const at = typeof raw === 'string' ? Date.parse(raw) : typeof raw === 'number' ? raw : NaN
  return Number.isFinite(at) ? at : undefined
}

function activeBranch(entries: readonly Entry[], leafId: string | null): Entry[] {
  const byId = new Map<string, Entry>()
  for (const entry of entries) if (typeof entry.id === 'string') byId.set(entry.id, entry)
  if (!leafId || !byId.has(leafId)) return [...entries]
  const path: Entry[] = []
  const seen = new Set<string>()
  let id: string | null = leafId
  while (id && !seen.has(id)) {
    seen.add(id)
    const entry = byId.get(id)
    if (!entry) break
    path.push(entry)
    id = typeof entry.parentId === 'string' ? entry.parentId : null
  }
  return path.reverse()
}

function measuredInput(entry: Entry): number | undefined {
  if (entry.type !== 'message') return undefined
  const message = recordOf(entry.message)
  if (!message || message.role !== 'assistant') return undefined
  if (message.stopReason === 'error' || message.stopReason === 'aborted') return undefined
  const usage = recordOf(message.usage)
  if (!usage) return undefined
  const input = (finiteNumber(usage.input) ?? 0) + (finiteNumber(usage.cacheRead) ?? 0) + (finiteNumber(usage.cacheWrite) ?? 0)
  return input > 0 ? input : undefined
}

export function compactionHistory(entries: readonly unknown[], leafId: string | null): CompactionHistoryItem[] {
  const path = activeBranch(entries.map(recordOf).filter((entry): entry is Entry => !!entry), leafId)
  const items: CompactionHistoryItem[] = []
  let open: CompactionHistoryItem | null = null
  for (const entry of path) {
    if (entry.type === 'compaction' && typeof entry.id === 'string') {
      const at = timestampOf(entry)
      const tokensBefore = finiteNumber(entry.tokensBefore)
      open = {
        id: entry.id,
        summaryTokens: estimateTokens(typeof entry.summary === 'string' ? entry.summary : ''),
        ...(at !== undefined ? { at } : {}),
        ...(tokensBefore !== undefined ? { tokensBefore } : {})
      }
      items.push(open)
      continue
    }
    if (!open) continue
    const after = measuredInput(entry)
    if (after !== undefined) {
      open.tokensAfter = after
      open = null
    }
  }
  return items.reverse()
}

export function compactionReclaim(item: Pick<CompactionHistoryItem, 'tokensBefore' | 'tokensAfter'>): number | null {
  const { tokensBefore, tokensAfter } = item
  if (tokensBefore === undefined || tokensAfter === undefined || tokensBefore <= 0) return null
  return Math.max(0, Math.min(100, Math.round(((tokensBefore - tokensAfter) / tokensBefore) * 100)))
}

export async function loadCompactionHistory(
  request: (request: NativeSessionHostRequest) => Promise<NativeSessionHostResult>,
  expectedSessionId: string
): Promise<CompactionHistoryLoad> {
  try {
    const result = await request({ action: 'entries', expectedSessionId })
    if (!result?.ok) return { ok: false, error: result?.error ?? '' }
    const leafId = typeof result.leafId === 'string' && result.leafId ? result.leafId : null
    return { ok: true, items: compactionHistory(Array.isArray(result.entries) ? result.entries : [], leafId) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
