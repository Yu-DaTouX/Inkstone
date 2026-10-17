import { create } from 'zustand'
import type { ProviderQuota } from '../../../shared/ipc'

export const LIVE_QUOTA_PROVIDERS: ReadonlySet<string> = new Set(['claude-bridge', 'anthropic', 'openai-codex', 'commandcode'])
export const LIVE_QUOTA_MIN_GAP_MS = 60_000
export const LIVE_QUOTA_POLL_MS = 5 * 60_000
export const LIVE_QUOTA_LAST_GOOD_MS = 24 * 60 * 60_000

export interface LiveQuotaEntry {
  snapshot: ProviderQuota | null
  fetchedAt: number
  loading: boolean
}

interface LiveQuotaState {
  entries: Record<string, LiveQuotaEntry>
}

export const useLiveQuota = create<LiveQuotaState>(() => ({ entries: {} }))

const inflight = new Map<string, Promise<ProviderQuota | null>>()

export function liveQuotaSupported(provider: string): boolean {
  return LIVE_QUOTA_PROVIDERS.has(provider)
}

export function mergeLiveQuota(prior: ProviderQuota | null | undefined, next: ProviderQuota): ProviderQuota {
  if (next.windows?.length || !next.error) return next
  if (!prior?.windows?.length || next.checkedAt - prior.checkedAt > LIVE_QUOTA_LAST_GOOD_MS) return next
  return { ...prior, error: undefined, staleError: next.error }
}

function patchEntry(provider: string, patch: Partial<LiveQuotaEntry>): void {
  useLiveQuota.setState((state) => {
    const current = state.entries[provider] ?? { snapshot: null, fetchedAt: 0, loading: false }
    return { entries: { ...state.entries, [provider]: { ...current, ...patch } } }
  })
}

export function refreshLiveQuota(provider: string, options: { force?: boolean; budget?: number } = {}): Promise<ProviderQuota | null> {
  if (!liveQuotaSupported(provider)) return Promise.resolve(null)
  const pending = inflight.get(provider)
  if (pending) return pending
  const entry = useLiveQuota.getState().entries[provider]
  if (!options.force && entry && Date.now() - entry.fetchedAt < LIVE_QUOTA_MIN_GAP_MS) return Promise.resolve(entry.snapshot)
  patchEntry(provider, { loading: true })
  const run = window.yan
    .providerQuota(provider, options.budget)
    .then((snapshot) => {
      const merged = mergeLiveQuota(useLiveQuota.getState().entries[provider]?.snapshot, snapshot)
      patchEntry(provider, { snapshot: merged, fetchedAt: Date.now(), loading: false })
      return merged
    })
    .catch((cause: unknown) => {
      const failed: ProviderQuota = {
        provider,
        supported: true,
        error: cause instanceof Error ? cause.message : String(cause),
        checkedAt: Date.now()
      }
      const merged = mergeLiveQuota(useLiveQuota.getState().entries[provider]?.snapshot, failed)
      patchEntry(provider, { snapshot: merged, fetchedAt: Date.now(), loading: false })
      return merged
    })
    .finally(() => inflight.delete(provider))
  inflight.set(provider, run)
  return run
}
