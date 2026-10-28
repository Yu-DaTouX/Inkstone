import { resolve } from 'node:path'
import type { UIMessage } from '../shared/ipc'
import { syncBaselineOf, type SyncBaseline } from './session-sync-plan'

const TTL_MS = 30_000
const MAX_ENTRIES = 4

const entries = new Map<string, { at: number; baseline: SyncBaseline }>()

function keyOf(file: string): string {
  const full = resolve(file)
  return process.platform === 'win32' ? full.toLowerCase() : full
}

export function rememberSyncBaseline(file: string | undefined, messages: readonly UIMessage[]): void {
  if (!file || !messages.length) return
  const key = keyOf(file)
  entries.delete(key)
  entries.set(key, { at: Date.now(), baseline: syncBaselineOf(messages) })
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value
    if (oldest === undefined) break
    entries.delete(oldest)
  }
}

export function takeSyncBaseline(file: string | undefined, now = Date.now()): SyncBaseline | undefined {
  if (!file) return undefined
  const key = keyOf(file)
  const entry = entries.get(key)
  if (!entry) return undefined
  entries.delete(key)
  return now - entry.at <= TTL_MS ? entry.baseline : undefined
}

export function clearSyncBaselines(): void {
  entries.clear()
}
