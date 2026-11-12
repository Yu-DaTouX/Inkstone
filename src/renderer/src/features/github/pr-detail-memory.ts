import type { PrActionPhase } from './pr-actions-model'
import type { PrDetail } from './pr-model'

export interface PrDetailSnapshot {
  repo: { name: string; url: string } | null
  detail: PrDetail
  diffPatch: string
  diffNote: { kind: 'truncated' | 'error'; message?: string } | null
}

export interface PrDetailMemoryEntry {
  snapshot?: PrDetailSnapshot
  action?: PrActionPhase
  commentDraft?: string
  commentOpen?: boolean
}

const MAX_ENTRIES = 16
const memory = new Map<string, PrDetailMemoryEntry>()

export function prMemoryKey(cwd: string, number: number): string {
  return `${cwd}\n${number}`
}

export function readPrMemory(key: string): PrDetailMemoryEntry {
  return memory.get(key) ?? {}
}

export function writePrMemory(key: string, patch: Partial<PrDetailMemoryEntry>): void {
  const next = { ...memory.get(key), ...patch }
  memory.delete(key)
  memory.set(key, next)
  while (memory.size > MAX_ENTRIES) {
    const oldest = memory.keys().next().value
    if (oldest === undefined) break
    memory.delete(oldest)
  }
}

export function restorableAction(state: PrActionPhase | undefined): PrActionPhase {
  if (!state || state.phase === 'running') return { phase: 'idle' }
  return state
}
