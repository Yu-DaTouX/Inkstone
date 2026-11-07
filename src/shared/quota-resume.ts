import type { QuotaWindow } from './ipc'
import { classifyModelError } from './model-errors'

export { QUOTA_RESUME_PROMPT } from './host-notice-text'

export const QUOTA_RESUME_POLL_MS = 60_000

export const RESET_GRACE_MS = 5_000

export function isQuotaWaitError(errorText: unknown): boolean {
  const info = classifyModelError(errorText)
  if (info.kind !== 'quota' || info.quotaScope !== 'usage') return false
  return !/insufficient[ _](?:balance|funds|credit)|balance|credit|funds|extra usage|余额|充值/i.test(info.text)
}

export function isRateLimitError(errorText: unknown): boolean {
  const info = classifyModelError(errorText)
  return info.kind === 'quota' && info.quotaScope === 'rate'
}

export function blockedQuotaWindows(windows: readonly QuotaWindow[]): QuotaWindow[] {
  return windows.filter((w) => !w.informational && (w.exceeded || (w.total > 0 && w.used >= w.total)))
}

export interface QuotaResumeDecision {
  ready: boolean
  resetAt?: number
  nextCheckAt: number
}

export function decideQuotaResume(windows: readonly QuotaWindow[], now: number): QuotaResumeDecision {
  const blocked = blockedQuotaWindows(windows)
  if (!blocked.length) return { ready: true, nextCheckAt: now }
  const resets = blocked.map((w) => w.resetAt).filter((t): t is number => typeof t === 'number' && Number.isFinite(t))
  const resetAt = resets.length ? Math.max(...resets) : undefined
  const poll = now + QUOTA_RESUME_POLL_MS
  const aligned = resetAt !== undefined && resetAt > now ? resetAt + RESET_GRACE_MS : poll
  return { ready: false, resetAt, nextCheckAt: Math.min(poll, aligned) }
}
