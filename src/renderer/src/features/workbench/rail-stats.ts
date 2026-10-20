import type { MessageKey } from '../../i18n'
import { formatDuration } from '../../../../shared/duration'
import { formatHitRate } from '../../../../shared/turns'
import type { SessionMetrics } from '../../../../shared/session-metrics'

export type RailStatKey = 'turns' | 'steps' | 'tps' | 'total' | 'hitRate'

export interface RailStatDetail {
  key: string
  label: string
  value: string
}

export interface RailStat {
  key: RailStatKey
  label: string
  value: string
  unit: string | null
  details: RailStatDetail[]
  notes: string[]
}

export interface RailStatsModel {
  stats: RailStat[]
  hitPercent: number | null
  speeds: number[]
  summary: { turns: number; total: string | null }
}

export interface RailStatsInput {
  metrics: SessionMetrics
  historyPartial: boolean
  subagentTokens: number
  speeds?: readonly number[]
  t: (key: MessageKey) => string
}

export function sumTime(ms: number | null, partial: boolean): string {
  if (ms === null) return '—'
  return `${partial ? '≥' : ''}${ms < 1000 ? `${Math.round(ms)}ms` : formatDuration(ms)}`
}

export function avgTime(ms: number | null): string {
  if (ms === null) return '—'
  return ms < 1000 ? `${Math.round(ms)}ms` : formatDuration(ms)
}

export function tpsNumber(tps: number | null): string {
  return tps === null ? '—' : tps >= 100 ? String(Math.round(tps)) : tps.toFixed(1)
}

export function tpsText(tps: number | null, perSec: string): string {
  return tps === null ? '—' : `${tpsNumber(tps)} ${perSec}`
}

export function tokenText(n: number | null, partial: boolean, unit: string): string {
  if (n === null) return '—'
  return `${partial ? '≥' : ''}${n.toLocaleString()} ${unit}`
}

export function countText(n: number, partial: boolean): string {
  return `${partial ? '≥' : ''}${n}`
}

export function abbrevCount(n: number): string {
  const trim = (v: number): string => {
    const s = v.toFixed(1)
    return s.endsWith('.0') ? s.slice(0, -2) : s
  }
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`
  if (n >= 1_000) return `${trim(n / 1_000)}K`
  return String(n)
}

export function abbrevToken(n: number | null, unit: string): string {
  if (n === null) return '—'
  return `${abbrevCount(n)} ${unit}`
}

export function hasRailStats(metrics: SessionMetrics): boolean {
  return metrics.steps > 0 || metrics.turns > 0 || metrics.total !== null
}

export function shortHitRate(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return '—'
  if (pct >= 100) return '100%'
  return `${(Math.floor(Math.max(0, pct) * 10) / 10).toFixed(1)}%`
}

function clampPercent(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null
  return Math.min(100, Math.max(0, value))
}

export function buildRailStats({ metrics, historyPartial, subagentTokens, speeds = [], t }: RailStatsInput): RailStatsModel | null {
  if (!hasRailStats(metrics)) return null
  const unit = t('tok.unit')
  const perSec = t('tok.perSec')
  const historyNotes = historyPartial ? [t('sm.historyPartialTip')] : []
  const timingPartial = metrics.modelPartial || metrics.toolPartial || metrics.ttftPartial || metrics.tpsPartial
  const tokenNotes = [...historyNotes, ...(metrics.partial ? [t('sm.partialTip')] : [])]
  const totalDetails: RailStatDetail[] = [
    { key: 'total', label: t('sm.total'), value: tokenText(metrics.total, metrics.partial, unit) },
    ...(subagentTokens > 0
      ? [{ key: 'withSubagents', label: t('sm.withSubagents'), value: tokenText((metrics.total ?? 0) + subagentTokens, metrics.partial, unit) }]
      : []),
    { key: 'inputUncached', label: t('sm.inputUncached'), value: tokenText(metrics.input, metrics.partial, unit) },
    { key: 'cacheRead', label: t('sm.cacheRead'), value: tokenText(metrics.cacheRead, metrics.partial, unit) },
    ...(metrics.cacheWrite === null
      ? []
      : [{ key: 'cacheWrite', label: t('sm.cacheWrite'), value: tokenText(metrics.cacheWrite, metrics.partial, unit) }]),
    { key: 'output', label: t('sm.output'), value: tokenText(metrics.output, metrics.partial, unit) }
  ]
  const stats: RailStat[] = [
    { key: 'turns', label: t('sm.turns'), value: countText(metrics.turns, historyPartial), unit: null, details: [], notes: historyNotes },
    { key: 'steps', label: t('sm.steps'), value: countText(metrics.steps, historyPartial), unit: null, details: [], notes: historyNotes },
    {
      key: 'total',
      label: t('sm.total'),
      value: metrics.total === null ? '—' : `${metrics.partial ? '≥' : ''}${abbrevCount(metrics.total)}`,
      unit: metrics.total === null ? null : unit,
      details: totalDetails,
      notes: tokenNotes
    },
    {
      key: 'hitRate',
      label: t('sm.hitRate'),
      value: shortHitRate(metrics.hitRate),
      unit: null,
      details: [
        { key: 'hitRate', label: t('sm.hitRate'), value: formatHitRate(metrics.hitRate) ?? '—' },
        { key: 'hitRateLatest', label: t('sm.hitRateLatest'), value: formatHitRate(metrics.latestHitRate) ?? '—' }
      ],
      notes: tokenNotes
    },
    {
      key: 'tps',
      label: t('sm.tps'),
      value: tpsNumber(metrics.tps),
      unit: metrics.tps === null ? null : perSec,
      details: [
        { key: 'modelTime', label: t('sm.modelTime'), value: sumTime(metrics.modelMs, metrics.modelPartial) },
        { key: 'toolTime', label: t('sm.toolTime'), value: sumTime(metrics.toolMs, metrics.toolPartial) },
        { key: 'ttft', label: t('sm.ttft'), value: avgTime(metrics.ttftMs) }
      ],
      notes: timingPartial ? [t('sm.timingPartialTip')] : []
    }
  ]
  return {
    stats: metrics.tps === null ? stats.filter((stat) => stat.key !== 'tps') : stats,
    hitPercent: clampPercent(metrics.hitRate),
    speeds: speeds.filter((v) => Number.isFinite(v) && v > 0),
    summary: { turns: metrics.turns, total: metrics.total === null ? null : abbrevToken(metrics.total, unit) }
  }
}

export function railStatTitle(stat: RailStat): string {
  const exact = stat.details.find((d) => d.key === stat.key)
  const head = exact ? `${stat.label} ${exact.value}` : `${stat.label} ${stat.value}${stat.unit ? ` ${stat.unit}` : ''}`
  const lines = stat.details.filter((d) => d.key !== stat.key).map((d) => `${d.label} ${d.value}`)
  return [head, ...lines, ...stat.notes].join('\n')
}
