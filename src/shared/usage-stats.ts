export type UsageRange = 'all' | '30d' | '7d'

export interface UsageDay {
  m: number
  t: number
  c?: number
  h: Record<string, number>
  models: Record<string, number>
  modelCost?: Record<string, number>
}

export type FileUsage = Record<string, UsageDay>

export interface UsageModelShare {
  key: string
  tokens: number
  cost: number
  sources: string[]
}

export function usageModelId(key: string): string {
  return key.slice(key.lastIndexOf('/') + 1).toLowerCase()
}

export interface UsageTokenBreakdown {
  main: number
  subagents: number
}

export interface UsageStatsView {
  range: UsageRange
  sessions: number
  messages: number
  tokens: number
  tokenBreakdown: UsageTokenBreakdown
  cost: number
  costBreakdown: UsageTokenBreakdown
  activeDays: number
  peakHour: number | null
  models: UsageModelShare[]
  heat: Array<{ date: string; tokens: number }>
  at: number
}

export const HEAT_WEEKS = 53

export function localDay(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function rangeStart(range: UsageRange, now: number): string | null {
  if (range === 'all') return null
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - (range === '30d' ? 29 : 6))
  return localDay(d.getTime())
}

export function aggregateUsage(files: FileUsage[], range: UsageRange, now = Date.now()): UsageStatsView {
  return aggregateUsageSources({ main: files, subagents: [] }, range, now)
}

export function aggregateUsageSources(
  sources: { main: FileUsage[]; subagents: FileUsage[] },
  range: UsageRange,
  now = Date.now()
): UsageStatsView {
  const from = rangeStart(range, now)
  const inRange = (day: string): boolean => from === null || day >= from
  let sessions = 0
  let messages = 0
  let tokensMain = 0
  let tokensSubagents = 0
  let costMain = 0
  let costSubagents = 0
  const days = new Set<string>()
  const hours = new Array<number>(24).fill(0)
  const models = new Map<string, UsageModelShare>()
  const perDay = new Map<string, number>()
  const modelEntry = (source: string): UsageModelShare => {
    const key = usageModelId(source)
    const hit = models.get(key) ?? { key, tokens: 0, cost: 0, sources: [] }
    if (!hit.sources.includes(source)) hit.sources.push(source)
    models.set(key, hit)
    return hit
  }

  const collect = (files: FileUsage[], isMain: boolean): void => {
    for (const file of files) {
      let touched = false
      for (const [day, u] of Object.entries(file)) {
        perDay.set(day, (perDay.get(day) ?? 0) + u.t)
        if (!inRange(day)) continue
        if (isMain) {
          if (u.m > 0 || u.t > 0) {
            touched = true
            days.add(day)
          }
          messages += u.m
          tokensMain += u.t
          costMain += u.c ?? 0
          for (const [h, n] of Object.entries(u.h)) {
            const i = Number(h)
            if (i >= 0 && i < 24) hours[i] += n
          }
        } else {
          tokensSubagents += u.t
          costSubagents += u.c ?? 0
        }
        for (const [key, n] of Object.entries(u.models)) modelEntry(key).tokens += n
        for (const [key, c] of Object.entries(u.modelCost ?? {})) modelEntry(key).cost += c
      }
      if (touched) sessions++
    }
  }
  collect(sources.main, true)
  collect(sources.subagents, false)
  const tokens = tokensMain + tokensSubagents

  const peak = Math.max(...hours)
  const heat: UsageStatsView['heat'] = []
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const start = new Date(today)
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7) - (HEAT_WEEKS - 1) * 7)
  for (const d = new Date(start); d.getTime() <= today.getTime(); d.setDate(d.getDate() + 1)) {
    const date = localDay(d.getTime())
    heat.push({ date, tokens: perDay.get(date) ?? 0 })
  }

  return {
    range,
    sessions,
    messages,
    tokens,
    tokenBreakdown: { main: tokensMain, subagents: tokensSubagents },
    cost: costMain + costSubagents,
    costBreakdown: { main: costMain, subagents: costSubagents },
    activeDays: days.size,
    peakHour: peak > 0 ? hours.indexOf(peak) : null,
    models: [...models.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 8).map((model) => ({ ...model, sources: model.sources.sort() })),
    heat,
    at: now
  }
}

export function tokenBreakdownOf(stats: Pick<UsageStatsView, 'tokens' | 'tokenBreakdown'>): UsageTokenBreakdown {
  const breakdown = stats.tokenBreakdown
  if (breakdown && Number.isFinite(breakdown.main) && Number.isFinite(breakdown.subagents)) return breakdown
  return { main: stats.tokens, subagents: 0 }
}

export function heatLevels(values: number[]): number[] {
  const nonzero = values.filter((v) => v > 0).sort((a, b) => a - b)
  if (!nonzero.length) return values.map(() => 0)
  const q = (p: number): number => nonzero[Math.min(nonzero.length - 1, Math.floor(p * nonzero.length))]
  const [q1, q2, q3] = [q(0.25), q(0.5), q(0.75)]
  return values.map((v) => (v <= 0 ? 0 : v <= q1 ? 1 : v <= q2 ? 2 : v <= q3 ? 3 : 4))
}
