import type { ModelInfo } from '../../../../shared/ipc'
import { usageModelId, type UsageModelShare, type UsageRange, type UsageStatsView } from '../../../../shared/usage-stats'
import { dailyEntries, usageBars, usageModelFree, usageModelName } from '../settings/usage/usage-model'

const MIN_CHART_DAYS = 30
const shortDate = (date: string): string => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`

export function usageChartData(heat: UsageStatsView['heat'], range: UsageRange) {
  const firstActive = heat.findIndex((day) => day.tokens > 0)
  const wanted = range === '7d' ? 7 : range === '30d' ? 30 : firstActive < 0 ? MIN_CHART_DAYS : Math.max(MIN_CHART_DAYS, heat.length - firstActive)
  const points = heat.slice(Math.max(0, heat.length - wanted)).map((day) => ({ key: day.date, value: day.tokens, title: `${day.date} · ${day.tokens.toLocaleString()} Token` }))
  const axisLabels = points.length > 1
    ? [points[0].key, points[Math.floor((points.length - 1) / 2)].key, points[points.length - 1].key].map(shortDate)
    : []
  return { points, axisLabels }
}

export function providerOf(sources: readonly string[] | undefined): string {
  const source = sources?.[0] ?? ''
  const at = source.indexOf('/')
  return at > 0 ? source.slice(0, at) : ''
}

export function usageDayRows(heat: UsageStatsView['heat'], range: UsageRange) {
  return usageBars(dailyEntries(heat, range)).reverse().filter((bar) => bar.value > 0).map((bar) => ({ ...bar, cost: null, free: false, title: bar.key, provider: null }))
}

export function usageModelRows(entries: readonly UsageModelShare[], models: readonly ModelInfo[]) {
  if (!entries.length) return []
  const byKey = new Map<string, ModelInfo[]>()
  const bySource = new Map<string, number>()
  models.forEach((model, index) => {
    const key = usageModelId(model.id)
    const named = byKey.get(key)
    if (named) named.push(model)
    else byKey.set(key, [model])
    const source = `${model.provider}/${model.id}`
    if (!bySource.has(source)) bySource.set(source, index)
  })
  const bars = usageBars(entries.map((entry) => ({ key: entry.key, label: usageModelName(entry, byKey.get(entry.key) ?? []), value: entry.tokens })))
  return bars.map((bar, i) => {
    const entry = entries[i]
    let exact = models.length
    for (const source of entry.sources ?? []) exact = Math.min(exact, bySource.get(source) ?? models.length)
    const candidates = exact < models.length ? [models[exact]] : byKey.get(entry.key) ?? []
    return { ...bar, cost: entry.cost, free: usageModelFree(entry, candidates), title: entry.sources?.join(' · '), provider: providerOf(entry.sources) }
  })
}
