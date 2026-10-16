import type { QuotaWindow } from './ipc'

export type QuotaRefreshTrigger = 'initial' | 'periodic' | 'focus' | 'reset'

export type QuotaRefreshReason =
  | 'initial'
  | 'periodic'
  | 'focus-stale'
  | 'reset-due'
  | 'skip-hidden'
  | 'skip-unsupported'
  | 'skip-inflight'
  | 'skip-fresh'

export interface QuotaRefreshInput {
  trigger: QuotaRefreshTrigger
  now: number
  lastCheckedAt: number | null
  intervalMs: number
  visible: boolean
  supported: boolean | null
  provider: string
  inFlightProvider: string | null
}

export function decideQuotaRefresh(input: QuotaRefreshInput): {
  query: boolean
  reason: QuotaRefreshReason
} {
  if (!input.provider) return { query: false, reason: 'skip-unsupported' }
  if (input.supported === false) return { query: false, reason: 'skip-unsupported' }
  if (input.trigger !== 'initial' && !input.visible) return { query: false, reason: 'skip-hidden' }
  if (input.inFlightProvider === input.provider) return { query: false, reason: 'skip-inflight' }
  if (input.trigger === 'initial') return { query: true, reason: 'initial' }
  if (input.trigger === 'reset') return { query: true, reason: 'reset-due' }
  const last = input.lastCheckedAt
  if (last !== null && input.now - last < input.intervalMs) {
    return { query: false, reason: 'skip-fresh' }
  }
  return { query: true, reason: input.trigger === 'focus' ? 'focus-stale' : 'periodic' }
}

export function hasDueQuotaWindow(windows: readonly QuotaWindow[], now: number): boolean {
  return windows.some((w) => w.resetAt !== undefined && w.resetAt <= now && !w.exceeded)
}

export function claimDueQuotaWindows(windows: readonly QuotaWindow[], now: number, attempted: Set<string>): boolean {
  const keyOf = (window: QuotaWindow) => JSON.stringify([window.id, window.resetAt])
  const current = new Set(windows.map(keyOf))
  for (const key of attempted) if (!current.has(key)) attempted.delete(key)
  let claimed = false
  for (const window of windows) {
    if (!hasDueQuotaWindow([window], now)) continue
    const key = keyOf(window)
    if (attempted.has(key)) continue
    attempted.add(key)
    claimed = true
  }
  return claimed
}
