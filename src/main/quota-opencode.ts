import { pick } from '../shared/ui-lang'
import type { QuotaWindow } from '../shared/ipc'
import { WINDOW_DURATION } from '../shared/quota-forecast'

export function openCodeGoWindows(payload: unknown): QuotaWindow[] {
  if (!payload || typeof payload !== 'object') return []
  const usage = (payload as Record<string, unknown>).usage
  if (!usage || typeof usage !== 'object') return []
  const windows: QuotaWindow[] = []
  for (const [id, label, durationMs] of [
    ['rolling', pick('五小时', '5 hours'), WINDOW_DURATION.fiveHour],
    ['weekly', pick('本周', 'This week'), WINDOW_DURATION.week],
    ['monthly', pick('本月', 'This month'), WINDOW_DURATION.month]
  ] as const) {
    const value = (usage as Record<string, unknown>)[id]
    if (!value || typeof value !== 'object') continue
    const entry = value as Record<string, unknown>
    if (typeof entry.percent !== 'number' || !Number.isFinite(entry.percent) || entry.percent < 0) continue
    const resetAt = typeof entry.resetsAt === 'string' ? Date.parse(entry.resetsAt) : NaN
    windows.push({
      id, label, used: entry.percent, total: 100, durationMs,
      exceeded: entry.status === 'rate-limited' || entry.percent >= 100,
      ...(Number.isFinite(resetAt) ? { resetAt } : {})
    })
  }
  return windows
}
