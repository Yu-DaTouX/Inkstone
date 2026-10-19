import type { ReactElement } from 'react'
import { Badge, Meter } from '../ui'
import { useT, type TFunc } from '../i18n'
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
  if (forecast.kind === 'steady') {
    return { kind: forecast.kind, text: t('quota.fc.atReset', { pct: forecast.atResetPct }), tip: '' }
  }
  return {
    kind: forecast.kind,
    text: t('quota.fc.exhaust', { t: quotaCountdown(t, forecast.exhaustAt - now) }),
    tip: t('quota.fc.exhaustTip', { time: clock(forecast.exhaustAt) })
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
  compact = false
}: {
  window: QuotaWindow
  stale: boolean
  now: number
  testId?: string
  compact?: boolean
}): ReactElement {
  const t = useT()
  const awaiting = windowAwaitingReset(window, now)
  const greyed = stale || awaiting
  const pct = windowUsedPct(window) ?? 0
  const reset = quotaResetLine(t, window, now)
  const forecast = greyed ? null : quotaForecastLine(t, window, now)
  const subText = [!awaiting ? reset.text : '', forecast?.text ?? ''].filter(Boolean)
  const showSub = subText.length > 0 && (!compact || forecast?.kind === 'exhaust')
  return (
    <div
      className="quota-win"
      data-tone={quotaWindowTone(window, stale, now)}
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
          {awaiting ? t('quota.resetDue') : `${pct.toFixed(1)}%`}
        </span>
      </div>
      <Meter
        aria-label={window.label}
        value={awaiting ? 0 : Math.min(100, Math.max(0, pct))}
        minValue={0}
        maxValue={100}
        projectedPercent={greyed ? null : forecastProjectionPct(window.forecast)}
      />
      {showSub ? (
        <div className="quota-win-sub">
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
