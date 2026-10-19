import type { MessageKey } from '../../i18n'
import { formatDuration } from '../../../../shared/duration'
import { formatHitRate } from '../../../../shared/turns'
import type { SessionMetrics } from '../../../../shared/session-metrics'

export interface RailStatsRow {
  key: string
  label: string
  value: string
}

export interface RailStatsModel {
  session: RailStatsRow[]
  tokens: RailStatsRow[]
  notes: string[]
  summary: { turns: number; total: string | null }
}

export interface RailStatsInput {
  metrics: SessionMetrics
  historyPartial: boolean
  subagentTokens: number
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

export function tpsText(tps: number | null, perSec: string): string {
  return tps === null ? '—' : `${tps >= 100 ? Math.round(tps) : tps.toFixed(1)} ${perSec}`
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

export function buildRailStats({ metrics, historyPartial, subagentTokens, t }: RailStatsInput): RailStatsModel | null {
  if (!hasRailStats(metrics)) return null
  const unit = t('tok.unit')
  const perSec = t('tok.perSec')
  const session: RailStatsRow[] = [
    { key: 'turns', label: t('sm.turns'), value: countText(metrics.turns, historyPartial) },
    { key: 'steps', label: t('sm.steps'), value: countText(metrics.steps, historyPartial) },
    { key: 'tps', label: t('sm.tps'), value: tpsText(metrics.tps, perSec) },
    { key: 'modelTime', label: t('sm.modelTime'), value: sumTime(metrics.modelMs, metrics.modelPartial) },
    { key: 'toolTime', label: t('sm.toolTime'), value: sumTime(metrics.toolMs, metrics.toolPartial) },
    { key: 'ttft', label: t('sm.ttft'), value: avgTime(metrics.ttftMs) }
  ]
  const tokens: RailStatsRow[] = [
    { key: 'total', label: t('sm.total'), value: tokenText(metrics.total, metrics.partial, unit) },
    ...(subagentTokens > 0
      ? [
          {
            key: 'withSubagents',
            label: t('sm.withSubagents'),
            value: tokenText((metrics.total ?? 0) + subagentTokens, metrics.partial, unit)
          }
        ]
      : []),
    { key: 'hitRate', label: t('sm.hitRate'), value: formatHitRate(metrics.hitRate) ?? '—' },
    { key: 'hitRateLatest', label: t('sm.hitRateLatest'), value: formatHitRate(metrics.latestHitRate) ?? '—' },
    { key: 'inputUncached', label: t('sm.inputUncached'), value: tokenText(metrics.input, metrics.partial, unit) },
    { key: 'cacheRead', label: t('sm.cacheRead'), value: tokenText(metrics.cacheRead, metrics.partial, unit) },
    ...(metrics.cacheWrite === null
      ? []
      : [{ key: 'cacheWrite', label: t('sm.cacheWrite'), value: tokenText(metrics.cacheWrite, metrics.partial, unit) }]),
    { key: 'output', label: t('sm.output'), value: tokenText(metrics.output, metrics.partial, unit) }
  ]
  const notes: string[] = []
  if (historyPartial) notes.push(t('sm.historyPartialTip'))
  if (metrics.partial) notes.push(t('sm.partialTip'))
  if (metrics.modelPartial || metrics.toolPartial || metrics.ttftPartial || metrics.tpsPartial) {
    notes.push(t('sm.timingPartialTip'))
  }
  return {
    session,
    tokens,
    notes,
    summary: { turns: metrics.turns, total: metrics.total === null ? null : abbrevToken(metrics.total, unit) }
  }
}
