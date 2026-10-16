import type { PeekResult } from '../../../shared/ipc'
import { buildConversationTurns, type ConversationTurn } from '../../../shared/conversation-turns'

export const TURN_CACHE_MAX = 3

export interface TurnSnapshot {
  version: number
  turns: ConversationTurn[]
  total: number
  truncated: number
  bytes: number
}

export type TurnEntry =
  | { status: 'loading'; version: number }
  | { status: 'ready'; version: number; snapshot: TurnSnapshot }
  | { status: 'error'; version: number; error: string }

export interface TurnCacheState {
  entries: Record<string, TurnEntry>
  order: string[]
}

export interface BeginResult {
  state: TurnCacheState
  shouldLoad: boolean
}

export function initialTurnCache(): TurnCacheState {
  return { entries: {}, order: [] }
}

function touched(order: string[], path: string): string[] {
  return [path, ...order.filter((p) => p !== path)]
}

export function turnCacheBegin(state: TurnCacheState, path: string, version: number): BeginResult {
  const current = state.entries[path]
  if (current && current.version === version && current.status !== 'error') {
    return { state: { entries: state.entries, order: touched(state.order, path) }, shouldLoad: false }
  }
  return {
    state: {
      entries: { ...state.entries, [path]: { status: 'loading', version } },
      order: touched(state.order, path)
    },
    shouldLoad: true
  }
}

export type SettleOutcome = { ok: true; snapshot: TurnSnapshot } | { ok: false; error: string }

export function turnCacheSettle(
  state: TurnCacheState,
  path: string,
  version: number,
  outcome: SettleOutcome
): TurnCacheState {
  const current = state.entries[path]
  if (!current || current.version !== version) return state

  const entry: TurnEntry = outcome.ok
    ? { status: 'ready', version, snapshot: outcome.snapshot }
    : { status: 'error', version, error: outcome.error }

  return pruneTurns({ entries: { ...state.entries, [path]: entry }, order: touched(state.order, path) })
}

export function turnCacheSelect(state: TurnCacheState, path: string): TurnEntry | undefined {
  return state.entries[path]
}

export function snapshotFromPeek(version: number, peek: PeekResult): TurnSnapshot {
  return {
    version,
    turns: buildConversationTurns(peek.messages),
    total: peek.total,
    truncated: peek.truncated,
    bytes: peek.bytes
  }
}

export async function loadTurnSnapshot(
  path: string,
  version: number,
  peek: (path: string) => Promise<PeekResult | null>
): Promise<SettleOutcome> {
  try {
    const res = await peek(path)
    if (!res) return { ok: false, error: '内容不可读' }
    return { ok: true, snapshot: snapshotFromPeek(version, res) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

function pruneTurns(state: TurnCacheState): TurnCacheState {
  const loading = Object.keys(state.entries).filter((p) => state.entries[p]?.status === 'loading')
  const budget = Math.max(0, TURN_CACHE_MAX - loading.length)
  const keep = new Set(loading)
  for (const path of state.order) {
    if (keep.size >= loading.length + budget) break
    if (state.entries[path]?.status !== 'loading') keep.add(path)
  }
  const entries: Record<string, TurnEntry> = {}
  for (const path of Object.keys(state.entries)) {
    if (keep.has(path)) entries[path] = state.entries[path] as TurnEntry
  }
  return { entries, order: state.order.filter((p) => keep.has(p)) }
}
