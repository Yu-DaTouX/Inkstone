import type { QuotaWindow } from './ipc'

export interface QuotaSample {
  at: number
  pct: number
}

export type QuotaForecast =
  | { kind: 'sampling'; needMs: number }
  | { kind: 'uncertain' }
  | { kind: 'steady'; atResetPct: number; basedOnMs?: number; limitedByFiveHour?: boolean }
  | { kind: 'exhaust'; exhaustAt: number; earliestAt?: number; latestAt?: number; basedOnMs?: number; limitedByFiveHour?: boolean }

export interface QuotaForecastLimit {
  window: QuotaWindow
  samples: readonly QuotaSample[]
}

type ForecastWindow = Pick<QuotaWindow, 'used' | 'total' | 'resetAt' | 'durationMs' | 'informational' | 'exceeded'>

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export const QUOTA_STALE_MS = 30 * MINUTE
export const QUOTA_SAMPLE_GAP_MS = 4 * MINUTE
export const QUOTA_SAMPLE_KEEP_MS = 8 * DAY
export const QUOTA_SAMPLE_MAX = 2500
export const QUOTA_RESET_DROP_PCT = 5
export const QUOTA_EXHAUSTED_MARGIN_PCT = 0.5

export const WINDOW_DURATION = {
  fiveHour: 5 * HOUR,
  day: DAY,
  week: 7 * DAY,
  month: 30 * DAY
} as const

export function forecastSpan(durationMs: number): { lookbackMs: number; minSpanMs: number } {
  if (durationMs <= 12 * HOUR) return { lookbackMs: HOUR, minSpanMs: 15 * MINUTE }
  if (durationMs <= 2 * DAY) return { lookbackMs: 6 * HOUR, minSpanMs: HOUR }
  if (durationMs <= 8 * DAY) return { lookbackMs: 3 * DAY, minSpanMs: DAY }
  return { lookbackMs: 7 * DAY, minSpanMs: 2 * DAY }
}

export function windowUsedPct(window: Pick<QuotaWindow, 'used' | 'total'>): number | null {
  if (!(window.total > 0) || !Number.isFinite(window.used)) return null
  return (window.used / window.total) * 100
}

export function appendQuotaSample(samples: readonly QuotaSample[], sample: QuotaSample): QuotaSample[] {
  const prior = samples[samples.length - 1]
  if (!Number.isFinite(sample.at) || !Number.isFinite(sample.pct) || sample.pct < 0) return [...samples]
  if (prior && sample.at < prior.at) return [...samples]
  const kept = samples.filter((s) => s.at <= sample.at && sample.at - s.at <= QUOTA_SAMPLE_KEEP_MS)
  const tail = kept[kept.length - 1]
  if (tail && sample.at === tail.at) { kept[kept.length - 1] = sample; return kept }
  if (tail && sample.pct < tail.pct - QUOTA_RESET_DROP_PCT) return [sample]
  const beforeTail = kept[kept.length - 2]
  if (tail && beforeTail && sample.at - tail.at < QUOTA_SAMPLE_GAP_MS && tail.at - beforeTail.at < QUOTA_SAMPLE_GAP_MS) {
    kept[kept.length - 1] = sample
  } else {
    kept.push(sample)
  }
  return kept.length > QUOTA_SAMPLE_MAX ? kept.slice(kept.length - QUOTA_SAMPLE_MAX) : kept
}

function forecastWithLimit(
  samples: readonly QuotaSample[],
  window: ForecastWindow,
  now: number,
  limit: QuotaForecastLimit
): QuotaForecast | undefined {
  const short = limit.window
  const resetAt = short.resetAt
  const cycleMs = short.durationMs ?? WINDOW_DURATION.fiveHour
  const weekResetAt = window.resetAt
  const pct = windowUsedPct(window)
  const shortPct = windowUsedPct(short)
  if (pct === null || shortPct === null || !Number.isFinite(cycleMs) || cycleMs <= 0) return undefined
  if (resetAt === undefined || !Number.isFinite(resetAt) || resetAt <= now || weekResetAt === undefined) return undefined
  if (!window.durationMs || window.durationMs <= cycleMs) return undefined

  const weeklyByTime = new Map(samples.map(sample => [sample.at, sample.pct]))
  const pairs = limit.samples.flatMap(sample => {
    const weekly = weeklyByTime.get(sample.at)
    return weekly === undefined || sample.at < now - cycleMs || sample.at > now
      ? []
      : [{ at: sample.at, short: sample.pct, weekly }]
  })
  let end = pairs.length - 1
  while (end > 0 && pairs[end - 1].short >= 100) end -= 1
  const { lookbackMs, minSpanMs } = forecastSpan(cycleMs)
  const anchor = pairs[end]?.at ?? now
  const recent = pairs.slice(0, end + 1).filter(sample => sample.at >= anchor - lookbackMs)
  let activeMs = 0
  let shortDelta = 0
  let weeklyDelta = 0
  for (let i = 1; i < recent.length; i += 1) {
    const before = recent[i - 1]
    const after = recent[i]
    if (after.at <= before.at || before.short >= 100) continue
    if (after.short < before.short || after.weekly < before.weekly) return { kind: 'sampling', needMs: minSpanMs }
    activeMs += after.at - before.at
    shortDelta += after.short - before.short
    weeklyDelta += after.weekly - before.weekly
  }
  if (activeMs < minSpanMs) return { kind: 'sampling', needMs: minSpanMs - activeMs }
  if (weeklyDelta <= 0) return { kind: 'steady', atResetPct: Math.round(pct) }
  if (!(shortDelta > 0)) return { kind: 'sampling', needMs: minSpanMs }

  const shortRate = shortDelta / activeMs
  const weeklyRate = weeklyDelta / activeMs
  const activeNeeded = (100 - pct) / weeklyRate
  const currentRemaining = short.exceeded ? 0 : Math.max(0, 100 - shortPct)
  const currentActive = Math.min(Math.min(resetAt, weekResetAt) - now, currentRemaining / shortRate)
  if (activeNeeded <= currentActive) return { kind: 'exhaust', exhaustAt: Math.round(now + activeNeeded) }
  const futureMs = Math.max(0, weekResetAt - resetAt)
  const activePerCycle = Math.min(cycleMs, 100 / shortRate)
  const fullCycles = Math.floor(futureMs / cycleMs)
  const availableActive = currentActive + fullCycles * activePerCycle + Math.min(futureMs % cycleMs, activePerCycle)
  const limitedByFiveHour = availableActive < weekResetAt - now
  const projected = pct + availableActive * weeklyRate
  if (projected < 100) return { kind: 'steady', atResetPct: Math.round(projected), limitedByFiveHour }
  const futureActive = activeNeeded - currentActive
  const cyclesBefore = Math.max(0, Math.ceil(futureActive / activePerCycle) - 1)
  return {
    kind: 'exhaust',
    exhaustAt: Math.round(resetAt + cyclesBefore * cycleMs + futureActive - cyclesBefore * activePerCycle),
    limitedByFiveHour
  }
}

export function forecastQuota(
  samples: readonly QuotaSample[],
  window: ForecastWindow,
  now: number,
  limit?: QuotaForecastLimit
): QuotaForecast | undefined {
  const pct = windowUsedPct(window)
  if (pct === null || window.informational || window.exceeded) return undefined
  if (!window.durationMs || !Number.isFinite(window.durationMs) || window.durationMs <= 0 || window.resetAt === undefined || !Number.isFinite(window.resetAt) || window.resetAt <= now) return undefined
  if (100 - pct <= QUOTA_EXHAUSTED_MARGIN_PCT) return undefined
  const { lookbackMs, minSpanMs } = forecastSpan(window.durationMs)
  const cycleStart = window.resetAt - window.durationMs
  const recent = samples.filter((s) => Number.isFinite(s.at) && Number.isFinite(s.pct) && s.at >= Math.max(now - lookbackMs, cycleStart) && s.at <= now)
  if (limit && !limit.window.informational && !limit.window.allowsOverage && windowSpan(limit.window).span === 'fiveHour'
    && window.durationMs > (limit.window.durationMs ?? WINDOW_DURATION.fiveHour)) {
    return forecastWithLimit(recent, window, now, limit)
  }
  const first = recent[0]
  const last = recent[recent.length - 1]
  const span = first && last ? last.at - first.at : 0
  if (!first || !last || span < minSpanMs) return { kind: 'sampling', needMs: minSpanMs - span }
  if (now - last.at > QUOTA_STALE_MS || Math.abs(last.pct - pct) > 0.5) return undefined
  if (recent.some((sample, index) => index > 0 && (sample.at <= recent[index - 1].at || sample.pct < recent[index - 1].pct))) return { kind: 'uncertain' }
  const rate = (last.pct - first.pct) / span
  if (window.durationMs > 2 * DAY) {
    if (recent.length < 6 || last.pct - first.pct < 3) return { kind: 'uncertain' }
    const middle = recent.find((sample) => sample.at >= first.at + span / 2)
    if (!middle || middle.at === first.at || middle.at === last.at) return { kind: 'uncertain' }
    const beforeRate = (middle.pct - first.pct) / (middle.at - first.at)
    const afterRate = (last.pct - middle.pct) / (last.at - middle.at)
    if (Math.min(beforeRate, afterRate) <= 0 || Math.max(beforeRate, afterRate) > 3 * Math.min(beforeRate, afterRate)) return { kind: 'uncertain' }
    const uncertainty = Math.max(1 / span, Math.abs(beforeRate - afterRate) / 2)
    const lowRate = rate - uncertainty
    const highRate = rate + uncertainty
    if (!(lowRate > 0)) return { kind: 'uncertain' }
    const projected = pct + rate * (window.resetAt - now)
    if (pct + highRate * (window.resetAt - now) < 100) return { kind: 'steady', atResetPct: Math.round(projected), basedOnMs: span }
    const earliestAt = Math.round(now + (100 - pct) / highRate)
    const latestAt = Math.round(now + (100 - pct) / lowRate)
    if (latestAt >= window.resetAt) return { kind: 'uncertain' }
    return { kind: 'exhaust', exhaustAt: Math.round(now + (100 - pct) / rate), earliestAt, latestAt, basedOnMs: span }
  }
  if (!(rate > 0)) return { kind: 'steady', atResetPct: Math.round(pct) }
  const projected = pct + rate * (window.resetAt - now)
  if (projected < 100) return { kind: 'steady', atResetPct: Math.round(projected) }
  return { kind: 'exhaust', exhaustAt: Math.round(now + (100 - pct) / rate) }
}

export function forecastProjectionPct(forecast: QuotaForecast | undefined): number | null {
  if (!forecast || forecast.kind === 'sampling' || forecast.kind === 'uncertain') return null
  return forecast.kind === 'exhaust' ? 100 : Math.min(100, forecast.atResetPct)
}

export function quotaReadingStale(checkedAt: number, now: number, failed: boolean): boolean {
  return failed || now - checkedAt > QUOTA_STALE_MS
}

export function windowAwaitingReset(window: Pick<QuotaWindow, 'resetAt'>, now: number): boolean {
  return window.resetAt !== undefined && window.resetAt <= now
}

export function bindingQuotaWindow(windows: readonly QuotaWindow[] | undefined): QuotaWindow | null {
  let best: QuotaWindow | null = null
  let bestPct = -1
  for (const window of windows ?? []) {
    if (window.informational) continue
    const pct = windowUsedPct(window)
    if (pct === null) continue
    if (pct > bestPct) {
      best = window
      bestPct = pct
    }
  }
  return best
}

export type WindowSpan = 'fiveHour' | 'day' | 'week' | 'month' | 'hours' | 'other'

export function windowSpan(window: Pick<QuotaWindow, 'durationMs' | 'id' | 'label'>): { span: WindowSpan; hours?: number } {
  const ms = window.durationMs
  if (ms) {
    const near = (target: number): boolean => Math.abs(ms - target) <= target * 0.05
    if (near(WINDOW_DURATION.fiveHour)) return { span: 'fiveHour' }
    if (near(WINDOW_DURATION.day)) return { span: 'day' }
    if (near(WINDOW_DURATION.week)) return { span: 'week' }
    if (ms >= 28 * DAY && ms <= 31 * DAY) return { span: 'month' }
    if (ms < DAY) return { span: 'hours', hours: Math.max(1, Math.round(ms / HOUR)) }
    return { span: 'other' }
  }
  if (window.id === 'fiveHour' || window.id === 'five_hour' || /五小时|5\s*小时|\b5\s*h/i.test(window.label)) return { span: 'fiveHour' }
  if (window.id === 'weekly' || /每周|本周|weekly|\bweek\b/i.test(window.label)) return { span: 'week' }
  if (window.id === 'monthly' || /本月|月度|monthly|\bmonth\b/i.test(window.label)) return { span: 'month' }
  return { span: 'other' }
}
