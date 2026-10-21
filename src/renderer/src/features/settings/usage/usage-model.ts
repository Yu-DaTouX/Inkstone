import type { UsageRange } from '../../../../../shared/usage-stats'

export const USAGE_RANGES: readonly UsageRange[] = ['all', '30d', '7d']

export type UsageDimension = 'day' | 'model'
export const USAGE_DIMENSIONS: readonly UsageDimension[] = ['day', 'model']

export const DAILY_MAX_DAYS = 30

export function modelShare(tokens: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0
  return Math.min(1, Math.max(0, tokens / total))
}

export function peakHourText(hour: number | null): string | null {
  if (hour === null || !Number.isInteger(hour) || hour < 0 || hour > 23) return null
  return `${String(hour).padStart(2, '0')}:00`
}

export interface UsageBar {
  key: string
  label: string
  value: number
  share: number
  ratio: number
}

export function usageBars(entries: ReadonlyArray<{ key: string; label?: string; value: number }>): UsageBar[] {
  const total = entries.reduce((sum, entry) => sum + Math.max(0, entry.value), 0)
  const max = entries.reduce((m, entry) => Math.max(m, Math.max(0, entry.value)), 0)
  return entries.map((entry) => ({
    key: entry.key,
    label: entry.label ?? entry.key,
    value: entry.value,
    share: modelShare(entry.value, total),
    ratio: max > 0 ? Math.min(1, Math.max(0, entry.value / max)) : 0
  }))
}

export function dailyEntries(
  heat: ReadonlyArray<{ date: string; tokens: number }>,
  range: UsageRange
): Array<{ key: string; label: string; value: number }> {
  const wanted = range === '7d' ? 7 : range === '30d' ? 30 : heat.length
  const take = Math.min(wanted, DAILY_MAX_DAYS)
  return heat.slice(Math.max(0, heat.length - take)).map((day) => ({ key: day.date, label: day.date, value: day.tokens }))
}
