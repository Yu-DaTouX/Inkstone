import type { ReactElement } from 'react'
import { Badge, Meter, type ProgressTone } from '../ui'
import { useT, type MessageKey, type TFunc } from '../i18n'
import type { QuotaWindow } from '../../../shared/ipc'
import { quotaTone } from '../../../shared/quota-tone'
import {
  forecastProjectionPct,
  windowAwaitingReset,
  windowSpan,
  windowUsedPct,
  type QuotaForecast
} from '../../../shared/quota-forecast'
import './quota-window.css'

export type QuotaWindowTone = 'ok' | 'ask' | 'fail' | 'stale'

const READ_NOW_MS = 60_000

const METER_TONE: Record<QuotaWindowTone, ProgressTone> = { ok: 'ink', ask: 'ask', fail: 'fail', stale: 'muted' }

export function quotaCountdown(t: TFunc, ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const d = Math.floor(total / 86400)
  const h = Math.floor((total % 86400) / 3600)
  const m = Math.floor((total % 3600) / 60)
  if (d > 0) return t('quota.durDH', { d, h })
  if (h > 0) return t('quota.durHM', { h, m })
  return t('quota.durM', { m: Math.max(1, m) })
}

const clock = (at: number): string => new Date(at).toLocaleString(undefined, { hour12: false })

export function quotaReadAgo(t: TFunc, checkedAt: number, now: number): string {
  return now - checkedAt < READ_NOW_MS ? t('quota.readNow') : t('quota.readAgo', { t: quotaCountdown(t, now - checkedAt) })
}

export function quotaResetLine(t: TFunc, window: QuotaWindow, now: number): { text: string; tip: string } {
  if (window.resetAt === undefined) return { text: '', tip: '' }
  const tip = t('quota.resetAtTip', { time: clock(window.resetAt) })
  if (window.resetAt <= now) return { text: t('quota.resetDue'), tip }
  if (window.id === 'monthly') {
    const date = new Date(window.resetAt)
    return { text: t('quota.resetOn', { d: `${date.getMonth() + 1}/${date.getDate()}` }), tip }
  }
  return { text: t('quota.resetIn', { t: quotaCountdown(t, window.resetAt - now) }), tip }
}

export function quotaForecastLine(
  t: TFunc,
  window: QuotaWindow,
  now: number
): { kind: QuotaForecast['kind'] | ''; text: string; tip: string } {
  const forecast = window.forecast
  if (!forecast || windowAwaitingReset(window, now)) return { kind: '', text: '', tip: '' }
  if (forecast.kind === 'sampling') {
    return { kind: forecast.kind, text: t('quota.fc.sampling', { t: quotaCountdown(t, forecast.needMs) }), tip: '' }
  }
  if (forecast.kind === 'uncertain') return { kind: forecast.kind, text: t('quota.fc.uncertain'), tip: t('quota.fc.uncertainTip') }
  const limitTip = forecast.limitedByFiveHour ? t('quota.fc.fiveHourTip') : ''
  const historyTip = forecast.basedOnMs ? t('quota.fc.historyTip', { t: quotaCountdown(t, forecast.basedOnMs) }) : ''
  if (forecast.kind === 'steady') {
    return { kind: forecast.kind, text: t(forecast.basedOnMs ? 'quota.fc.historyReset' : 'quota.fc.atReset', { pct: forecast.atResetPct }), tip: [historyTip, limitTip].filter(Boolean).join('\n') }
  }
  return {
    kind: forecast.kind,
    text: forecast.earliestAt && forecast.latestAt
      ? t('quota.fc.range', { min: quotaCountdown(t, forecast.earliestAt - now), max: quotaCountdown(t, forecast.latestAt - now) })
      : t('quota.fc.exhaust', { t: quotaCountdown(t, forecast.exhaustAt - now) }),
    tip: [historyTip || t('quota.fc.exhaustTip', { time: clock(forecast.exhaustAt) }), limitTip].filter(Boolean).join('\n')
  }
}

export function quotaShortLabel(t: TFunc, window: QuotaWindow): string {
  const { span, hours } = windowSpan(window)
  if (span === 'fiveHour') return '5h'
  if (span === 'day') return t('quota.win.dayShort')
  if (span === 'week') return t('quota.win.weekShort')
  if (span === 'month') return t('quota.win.monthShort')
  if (span === 'hours') return t('quota.win.hoursShort', { h: hours ?? 1 })
  return window.label
}

export function quotaPace(window: QuotaWindow, now: number): { pace: 'ahead' | 'on' | 'under'; timeLeftPct: number } | null {
  if (window.resetAt === undefined || !window.durationMs || window.durationMs <= 0 || window.resetAt <= now) return null
  const elapsed = Math.max(0, Math.min(1, (window.durationMs - (window.resetAt - now)) / window.durationMs))
  const gap = (windowUsedPct(window) ?? 0) - elapsed * 100
  return { pace: gap > 5 ? 'ahead' : gap < -5 ? 'under' : 'on', timeLeftPct: Math.round((1 - elapsed) * 100) }
}

export function quotaWindowName(t: TFunc, window: QuotaWindow): string {
  const { span } = windowSpan(window)
  if (span === 'fiveHour') return t('quota.win.fiveHour')
  if (span === 'week') return t('quota.win.thisWeek')
  if (span === 'month') return t('quota.win.monthly')
  if (span === 'day') return t('quota.win.daily')
  return window.label
}

function quotaShortReset(t: TFunc, window: QuotaWindow, now: number): string {
  if (window.resetAt === undefined || window.resetAt <= now) return ''
  if (window.id === 'monthly') {
    const date = new Date(window.resetAt)
    return `${date.getMonth() + 1}/${date.getDate()}`
  }
  return quotaCountdown(t, window.resetAt - now)
}

export function quotaWindowTone(window: QuotaWindow, stale: boolean, now: number): QuotaWindowTone {
  if (stale || windowAwaitingReset(window, now)) return 'stale'
  if (window.informational) return 'ok'
  return quotaTone(windowUsedPct(window) ?? 0, window.exceeded)
}

export function QuotaWindowRow({
  window,
  stale,
  now,
  testId,
  compact = false,
  detail = false
}: {
  window: QuotaWindow
  stale: boolean
  now: number
  testId?: string
  compact?: boolean
  detail?: boolean
}): ReactElement {
  const t = useT()
  const awaiting = windowAwaitingReset(window, now)
  const greyed = stale || awaiting
  const pct = windowUsedPct(window) ?? 0
  const reset = quotaResetLine(t, window, now)
  const forecast = greyed ? null : quotaForecastLine(t, window, now)
  const subText = [!awaiting ? reset.text : '', forecast?.text ?? ''].filter(Boolean)
  const showSub = subText.length > 0 && (!compact || forecast?.kind === 'exhaust')
  const tone = quotaWindowTone(window, stale, now)
  const left = Math.round(100 - Math.min(100, Math.max(0, pct)))
  const pace = detail && !greyed ? quotaPace(window, now) : null
  if (detail) {
    const awaitingTone: QuotaWindowTone = tone === 'ok' && pace?.pace === 'ahead' ? 'ask' : tone
    const notes = [
      window.estimated ? t('quota.estimatedTip') : '',
      pace ? t(`quota.pace.${pace.pace}` as MessageKey) : '',
      forecast?.text ?? '',
      forecast?.tip ?? ''
    ].filter(Boolean)
    const short = awaiting ? '' : quotaShortReset(t, window, now)
    return (
      <div
        className="quota-win"
        data-detail="1"
        data-tone={awaitingTone}
        data-forecast={forecast?.kind || undefined}
        data-sampling={forecast?.kind === 'sampling' || window.estimated ? '1' : undefined}
        data-testid={testId}
        title={[reset.tip, ...notes].filter(Boolean).join(" · ") || undefined}
      >
        <span className="quota-win-label">{quotaWindowName(t, window)}</span>
        <div className="quota-win-bar">
          <Meter aria-label={window.label} value={awaiting ? 0 : left} minValue={0} maxValue={100} tone={METER_TONE[awaitingTone]} />
          {pace ? <span className="quota-win-tick" style={{ left: `${Math.min(99, Math.max(1, pace.timeLeftPct))}%` }} aria-hidden="true" /> : null}
        </div>
        <span className="quota-win-reset ui-meta-num" title={reset.tip || undefined}>{short}</span>
        <span className="quota-win-value ui-meta-num">{awaiting ? t('quota.resetDue') : t('quota.leftPct', { pct: left })}</span>
      </div>
    )
  }
  return (
    <div
      className="quota-win"
      data-tone={tone}
      data-forecast={forecast?.kind || undefined}
      data-compact={compact ? '1' : undefined}
      data-testid={testId}
      title={compact && subText.length > 0 ? subText.join(' · ') : undefined}
    >
      <div className="quota-win-top">
        <span className="quota-win-label">{window.label}</span>
        {window.estimated ? (
          <span title={t('quota.estimatedTip')}>
            <Badge>{t('quota.estimated')}</Badge>
          </span>
        ) : null}
        <span className="quota-win-value ui-meta-num" title={awaiting ? reset.tip : undefined}>
          {awaiting ? t('quota.resetDue') : detail ? t('quota.leftPct', { pct: left }) : `${pct.toFixed(1)}%`}
        </span>
      </div>
      <div className="quota-win-bar">
        <Meter
          aria-label={window.label}
          value={awaiting ? 0 : detail ? left : Math.min(100, Math.max(0, pct))}
          minValue={0}
          maxValue={100}
          projectedPercent={greyed || detail ? null : forecastProjectionPct(window.forecast)}
          tone={METER_TONE[tone]}
        />
        {pace ? (
          <span
            className="quota-win-tick"
            style={{ left: `${Math.min(99, Math.max(1, pace.timeLeftPct))}%` }}
            title={t('quota.paceTip')}
            aria-hidden="true"
          />
        ) : null}
      </div>
      {showSub ? (
        <div className="quota-win-sub">
          {pace ? <span className="quota-win-pace" data-pace={pace.pace}>{t(`quota.pace.${pace.pace}` as MessageKey)}</span> : null}
          {!awaiting && reset.text ? <span title={reset.tip}>{reset.text}</span> : null}
          {forecast?.text ? (
            <span className="quota-win-forecast" data-testid={testId ? `${testId}-forecast` : undefined} title={forecast.tip || undefined}>
              {forecast.text}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
