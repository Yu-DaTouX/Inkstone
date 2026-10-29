import type { MessageKey } from '../../i18n'
import { formatHitRate } from '../../../../shared/turns'
import type { SessionMetrics, SessionTurnCounts } from '../../../../shared/session-metrics'

type DataTone = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8

export type RailSegmentKey = 'input' | 'cacheRead' | 'cacheWrite' | 'output' | 'model' | 'tool'

export interface RailSegment {
  key: RailSegmentKey
  label: string
  value: number
  tone: DataTone
  text: string
  title: string
}

export interface RailTokens {
  total: string
  unit: string
  title: string
  hit: string | null
  hitTitle: string | null
  ariaLabel: string
  segments: RailSegment[]
}

export interface RailTime {
  label: string
  baseMs: number
  partial: boolean
  ariaLabel: string
  segments: RailSegment[]
  detail: string
  title: string | null
}

export interface RailSpeed {
  label: string
  value: string
  unit: string
  bars: number[]
  live: number | null | undefined
  estimated: boolean
  caption: string
  title: string | null
}

export type RailGlanceMetric =
  | { kind: 'speed'; value: string; unit: string; bars: number[] | null; pending: number | null; estimated?: boolean }
  | { kind: 'tokens'; value: string; unit: string }
  | { kind: 'counts'; text: string }

export interface RailGlance {
  hit: number | null
  hitText: string | null
  hitLabel: string
  metric: RailGlanceMetric
  title: string
}

export interface RailFact {
  key: 'total' | 'hit' | 'subagents' | 'cost'
  label: string
  value: string
  unit?: string
  title: string | null
}

export interface RailStatsModel {
  glance: RailGlance
  headline: string
  headlineTitle: string | null
  tokens: RailTokens | null
  extras: string | null
  extrasTitle: string | null
  facts: RailFact[]
  time: RailTime | null
  speed: RailSpeed | null
  liveSince: number | null
  summary: { turns: number; total: string | null }
}

export interface RailStatsInput {
  metrics: SessionMetrics
  counts?: SessionTurnCounts
  historyPartial: boolean
  subagentTokens: number
  subagentCost?: number
  speeds?: readonly number[]
  latestSpeed?: number | null
  latestSpeedEstimated?: boolean
  liveSpeed?: number | null
  liveSpeedEstimated?: boolean
  liveSince?: number | null
  money?: (usd: number) => string
  t: (key: MessageKey, vars?: Record<string, string | number>) => string
}

const TONE: Record<RailSegmentKey, DataTone> = {
  input: 1,
  cacheRead: 2,
  cacheWrite: 3,
  output: 6,
  model: 1,
  tool: 7
}

export interface RailSpeedSample {
  speed: number
  estimated: boolean
}

export interface RailSpeedHold {
  identity: string
  sample: RailSpeedSample | null
}

export function retainRailSpeed(previous: RailSpeedHold | null, identity: string, sample: RailSpeedSample | null): RailSpeedHold {
  const valid = sample && Number.isFinite(sample.speed) && sample.speed > 0 ? sample : null
  return { identity, sample: valid ?? (previous?.identity === identity ? previous.sample : null) }
}

export function tpsNumber(tps: number | null): string {
  return tps === null ? '—' : tps >= 100 ? String(Math.round(tps)) : tps.toFixed(1)
}

export function tpsText(tps: number | null, perSec: string): string {
  return tps === null ? '—' : `${tpsNumber(tps)} ${perSec}`
}

export function tokenText(n: number | null, unit: string): string {
  if (n === null) return '—'
  return `${n.toLocaleString()} ${unit}`
}

export function countText(n: number): string {
  return String(n)
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

export function steadyCount(n: number): string {
  const v = Number.isFinite(n) ? Math.max(0, n) : 0
  if (v < 999.5) return String(Math.round(v))
  if (Math.round(v / 100) < 10_000) return `${(Math.round(v / 100) / 10).toFixed(1)}K`
  return `${(Math.round(v / 100_000) / 10).toFixed(1)}M`
}

export function clockText(ms: number): string {
  const raw = Number.isFinite(ms) ? Math.max(0, ms) : 0
  if (raw < 999.5) return `${Math.round(raw)}ms`
  const total = Math.round(raw / 1000)
  if (total < 60) return `${total}s`
  const pad = (n: number): string => String(n).padStart(2, '0')
  if (total < 3600) return `${Math.floor(total / 60)}m ${pad(total % 60)}s`
  return `${Math.floor(total / 3600)}h ${pad(Math.floor((total % 3600) / 60))}m`
}

export function spanText(ms: number): string {
  const raw = Number.isFinite(ms) ? Math.max(0, ms) : 0
  if (raw >= 999.5 && raw < 9950) return `${(raw / 1000).toFixed(1)}s`
  return clockText(raw)
}

export function sumTime(ms: number | null): string {
  if (ms === null) return '—'
  return clockText(ms)
}

export function hitText(pct: number | null): string | null {
  if (pct === null || !Number.isFinite(pct)) return null
  return `${Math.floor(Math.min(100, Math.max(0, pct)))}%`
}

export function costText(metrics: Pick<SessionMetrics, 'cost' | 'costEstimated' | 'costZero'>, money: (usd: number) => string): string | null {
  if (metrics.cost === null || metrics.costZero || !(metrics.cost > 0)) return null
  return `${metrics.costEstimated > 0 ? '≈' : ''}${money(metrics.cost)}`
}

export function hasRailStats(metrics: Pick<SessionMetrics, 'steps' | 'turns' | 'total'>): boolean {
  return metrics.steps > 0 || metrics.turns > 0 || metrics.total !== null
}

export function timingPartial(metrics: SessionMetrics): boolean {
  return (
    metrics.modelPartial ||
    metrics.toolPartial ||
    metrics.toolMs === null ||
    (metrics.modelMs === null && metrics.steps > 0)
  )
}

export function railTimeText(time: Pick<RailTime, 'baseMs'>, liveMs = 0): string {
  return clockText(time.baseMs + Math.max(0, liveMs))
}

function defaultMoney(usd: number): string {
  return `$${usd.toFixed(2)}`
}

function joinNotes(notes: readonly string[]): string | null {
  return notes.length > 0 ? notes.join('\n') : null
}

function buildTokens(metrics: SessionMetrics, input: RailStatsInput, notes: readonly string[]): RailTokens | null {
  if (metrics.total === null) return null
  const { t } = input
  const unit = t('tok.unit')
  const exact = (n: number | null): string => tokenText(n, unit)
  const segment = (key: RailSegmentKey, label: string, value: number | null): RailSegment => ({
    key,
    label,
    value: value ?? 0,
    tone: TONE[key],
    text: steadyCount(value ?? 0),
    title: `${label} ${exact(value)}`
  })
  const segments = [
    segment('input', t('sm.inputNew'), metrics.input),
    segment('cacheRead', t('sm.cacheRead'), metrics.cacheRead),
    ...(metrics.cacheWrite === null ? [] : [segment('cacheWrite', t('sm.cacheWrite'), metrics.cacheWrite)]),
    segment('output', t('sm.output'), metrics.output)
  ]
  const hit = hitText(metrics.hitRate)
  return {
    total: steadyCount(metrics.total),
    unit,
    title: [`${t('sm.total')} ${exact(metrics.total)}`, ...notes].join('\n'),
    hit: hit === null ? null : t('sm.cacheHit', { pct: hit }),
    hitTitle:
      hit === null
        ? null
        : `${t('sm.hitRate')} ${formatHitRate(metrics.hitRate) ?? '—'}\n${t('sm.hitRateLatest')} ${formatHitRate(metrics.latestHitRate) ?? '—'}`,
    ariaLabel: t('sm.composition'),
    segments
  }
}

function buildTime(metrics: SessionMetrics, input: RailStatsInput): RailTime | null {
  const toolMs = metrics.toolMs ?? 0
  if (metrics.modelMs === null && toolMs <= 0) return null
  const { t } = input
  const partial = timingPartial(metrics)
  const modelMs = metrics.modelMs ?? 0
  const segment = (key: 'model' | 'tool', label: string, value: number): RailSegment => ({
    key,
    label,
    value,
    tone: TONE[key],
    text: sumTime(value),
    title: `${label} ${sumTime(value)}`
  })
  const model = segment('model', t('sm.modelShort'), modelMs)
  const tool = segment('tool', t('sm.toolShort'), toolMs)
  const detail = [
    `${model.label} ${model.text}`,
    ...(toolMs > 0 ? [`${tool.label} ${tool.text}`] : []),
    ...(metrics.ttftMs === null ? [] : [`${t('sm.ttftShort')} ${spanText(metrics.ttftMs)}`])
  ].join(' · ')
  return {
    label: t('sm.elapsed'),
    baseMs: modelMs + toolMs,
    partial,
    ariaLabel: t('sm.timeSplit'),
    segments: toolMs > 0 ? [model, tool] : [model],
    detail,
    title: joinNotes(partial ? [t('sm.timingPartialTip')] : [])
  }
}

function buildSpeed(metrics: SessionMetrics, input: RailStatsInput): RailSpeed | null {
  const bars = (input.speeds ?? []).filter((v) => Number.isFinite(v) && v > 0)
  const live = input.liveSpeed === undefined ? undefined : input.liveSpeed !== null && Number.isFinite(input.liveSpeed) && input.liveSpeed > 0 ? input.liveSpeed : null
  const latest = input.latestSpeed === undefined ? bars.at(-1) ?? null : positive(input.latestSpeed)
  if (bars.length === 0 && live === undefined && latest === null && metrics.tps === null) return null
  const { t } = input
  const perSec = t('tok.perSec')
  const estimated = live !== undefined ? live !== null && input.liveSpeedEstimated === true : latest !== null && input.latestSpeedEstimated === true
  const caption = [
    ...(bars.length > 0 ? [t('sm.recentSteps', { n: bars.length })] : []),
    ...(latest === null ? [] : [t('sm.latestSpeed', { speed: tpsText(latest, perSec) })]),
    ...(live === undefined ? [] : [t('sm.liveStep')])
  ].join(' · ')
  return {
    label: t('sm.tps'),
    value:
      live === undefined
        ? `${estimated ? '≈' : ''}${tpsNumber(input.latestSpeed === undefined ? latest ?? metrics.tps : latest)}`
        : `${estimated ? '≈' : ''}${tpsNumber(live)}`,
    unit: perSec,
    bars,
    live,
    estimated,
    caption,
    title: joinNotes([
      ...(metrics.tpsPartial ? [t('sm.timingPartialTip')] : []),
      t('sm.outputSpeedTip'),
      ...(estimated ? [t('sm.liveSpeedEstimate')] : [])
    ])
  }
}

export const GLANCE_BARS = 3

function positive(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}

function buildGlance(metrics: SessionMetrics, input: RailStatsInput, headline: string): RailGlance {
  const { t } = input
  const unit = t('tok.unit')
  const perSec = t('tok.perSec')
  const bars = (input.speeds ?? []).filter((v) => Number.isFinite(v) && v > 0)
  const running = input.liveSpeed !== undefined
  const live = positive(input.liveSpeed)
  const liveEstimated = running && live !== null && input.liveSpeedEstimated === true
  const hit = metrics.hitRate !== null && Number.isFinite(metrics.hitRate) ? Math.min(100, Math.max(0, metrics.hitRate)) : null
  const settledSpeed = input.latestSpeed === undefined ? bars.at(-1) ?? positive(metrics.tps) : positive(input.latestSpeed)
  const settledEstimated = settledSpeed !== null && input.latestSpeedEstimated === true
  const metric: RailGlanceMetric = running
    ? {
        kind: 'speed',
        value: `${liveEstimated ? '≈' : ''}${tpsNumber(live)}`,
        unit: perSec,
        bars: bars.slice(-GLANCE_BARS),
        pending: live,
        ...(liveEstimated ? { estimated: true } : {})
      }
    : settledSpeed !== null || input.latestSpeed !== undefined
      ? { kind: 'speed', value: `${settledEstimated ? '≈' : ''}${tpsNumber(settledSpeed)}`, unit: perSec, bars: null, pending: null, ...(settledEstimated ? { estimated: true } : {}) }
      : metrics.total !== null
        ? { kind: 'tokens', value: steadyCount(metrics.total), unit }
        : { kind: 'counts', text: headline }
  const title = [
    headline,
    ...(metrics.total === null ? [] : [`${t('sm.total')} ${tokenText(metrics.total, unit)}`]),
    ...(hit === null ? [] : [`${t('sm.hitRate')} ${formatHitRate(metrics.hitRate) ?? '—'}`]),
    ...(running || settledSpeed === null ? [] : [`${t('sm.tps')} ${tpsText(settledSpeed, perSec)}`]),
    ...(running ? [`${t('sm.liveStep')} ${tpsText(live, perSec)}`] : []),
    ...(liveEstimated || !running && settledEstimated ? [t('sm.liveSpeedEstimate')] : []),
    ...(input.historyPartial ? [t('sm.historyPartialTip')] : []),
    ...(metrics.partial ? [t('sm.partialTip')] : [])
  ].join('\n')
  return { hit, hitText: hitText(hit), hitLabel: t('sm.hitRate'), metric, title }
}

export function buildRailStats(input: RailStatsInput): RailStatsModel | null {
  const { metrics, historyPartial, subagentTokens, t } = input
  const counts = input.counts ?? { turns: metrics.turns, steps: metrics.steps }
  if (!hasRailStats(metrics) && !hasRailStats({ ...counts, total: null })) return null
  const unit = t('tok.unit')
  const historyNotes = historyPartial ? [t('sm.historyPartialTip')] : []
  const tokenNotes = [...historyNotes, ...(metrics.partial ? [t('sm.partialTip')] : [])]
  const childCost = positive(input.subagentCost) ?? 0
  const cost = costText({
    cost: (metrics.cost ?? 0) + childCost,
    costEstimated: metrics.costEstimated,
    costZero: metrics.costZero && childCost === 0
  }, input.money ?? defaultMoney)
  const extras = [
    ...(subagentTokens > 0 && metrics.total !== null ? [`${t('sm.withSubagents')} +${steadyCount(subagentTokens)}`] : []),
    ...(cost === null ? [] : [t('sm.costLine', { cost })])
  ]
  const extrasTitle = [
    ...(subagentTokens > 0 && metrics.total !== null
      ? [`${t('sm.withSubagents')} ${tokenText(metrics.total + subagentTokens, unit)}`]
      : []),
    ...(cost !== null && metrics.costEstimated > 0 ? [t('sm.costEstimatedTip')] : [])
  ]
  const headline = t('sm.headline', { turns: countText(counts.turns), steps: countText(counts.steps) })
  const tokens = buildTokens(metrics, input, tokenNotes)
  const hit = hitText(metrics.hitRate)
  const facts: RailFact[] = [
    ...(tokens ? [{ key: 'total' as const, label: t('sm.total'), value: tokens.total, unit: tokens.unit, title: tokens.title }] : []),
    ...(tokens && hit !== null ? [{ key: 'hit' as const, label: t('sm.hitRate'), value: hit, title: tokens.hitTitle }] : []),
    ...(subagentTokens > 0 && metrics.total !== null
      ? [{ key: 'subagents' as const, label: t('sm.withSubagents'), value: `+${steadyCount(subagentTokens)}`, title: `${t('sm.withSubagents')} ${tokenText(metrics.total + subagentTokens, unit)}` }]
      : []),
    ...(cost === null
      ? []
      : [{ key: 'cost' as const, label: t('usage.cost'), value: cost, title: metrics.costEstimated > 0 ? t('sm.costEstimatedTip') : null }])
  ]
  return {
    glance: buildGlance(metrics, input, headline),
    headline,
    headlineTitle: joinNotes(historyNotes),
    tokens,
    extras: extras.length > 0 ? extras.join(' · ') : null,
    extrasTitle: joinNotes(extrasTitle),
    facts,
    time: buildTime(metrics, input),
    speed: buildSpeed(metrics, input),
    liveSince: input.liveSince ?? null,
    summary: { turns: counts.turns, total: metrics.total === null ? null : abbrevToken(metrics.total, unit) }
  }
}
