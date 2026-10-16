export const UI_TIMEOUT_DEFAULT = 3 * 60_000
export const UI_TIMEOUT_APPROVAL = 2 * 60_000
export const UI_TIMEOUT_MIN = 5_000
export const UI_TIMEOUT_MAX = 10 * 60_000
export const UI_TIMEOUT_EXTEND = 2 * 60_000
export const UI_TIMEOUT_REMAINING_MAX = 30 * 60_000
export const UI_TIMEOUT_HARD = 10 * 60_000

export function requestedTimeout(raw: unknown): number {
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return UI_TIMEOUT_DEFAULT
  return Math.min(Math.max(Math.floor(value), UI_TIMEOUT_MIN), UI_TIMEOUT_MAX)
}

export function extendDeadline(deadline: number, now: number, extraMs: unknown = UI_TIMEOUT_EXTEND): number {
  const value = Number(extraMs)
  const extra = Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), UI_TIMEOUT_EXTEND) : UI_TIMEOUT_EXTEND
  return Math.min(deadline + extra, now + UI_TIMEOUT_REMAINING_MAX)
}

export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
}
