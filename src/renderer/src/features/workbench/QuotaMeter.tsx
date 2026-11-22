import type { ReactElement } from 'react'
import { Meter, type ProgressTone } from '../../ui'
import { Gauge, RotateCcw, TrendingDown, TrendingUp, type LucideIcon } from '../../ui/icons'
import type { MessageKey, TFunc } from '../../i18n'
import type { QuotaWindow } from '../../../../shared/ipc'
import { windowAwaitingReset, windowUsedPct } from '../../../../shared/quota-forecast'
import { quotaCountdown, quotaPace, quotaWindowTone, type QuotaWindowTone } from '../../patterns/QuotaWindowRow'

const METER_TONE: Record<QuotaWindowTone, ProgressTone> = { ok: 'muted', ask: 'ask', fail: 'fail', stale: 'muted' }
const PACE_ICON: Record<'ahead' | 'on' | 'under', LucideIcon> = { ahead: TrendingUp, on: Gauge, under: TrendingDown }

const pad = (value: number): string => String(value).padStart(2, '0')

function clockAt(at: number, now: number): string {
  const date = new Date(at)
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  return date.toDateString() === new Date(now).toDateString() ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`
}

export function QuotaMeter({ window, name, stale, now, t }: { window: QuotaWindow; name: string; stale: boolean; now: number; t: TFunc }): ReactElement {
  const awaiting = windowAwaitingReset(window, now)
  const base = quotaWindowTone(window, stale, now)
  const pace = stale || awaiting || base === 'fail' ? null : quotaPace(window, now)
  const tone: QuotaWindowTone = base === 'ok' && pace?.pace === 'ahead' ? 'ask' : base
  const used = Math.round(Math.min(100, Math.max(0, windowUsedPct(window) ?? 0)))
  const resetAt = window.resetAt !== undefined && !awaiting ? window.resetAt : undefined
  const tip = [
    window.label,
    resetAt !== undefined ? t('quota.resetAtTip', { time: clockAt(resetAt, now) }) : '',
    pace ? t(`quota.pace.${pace.pace}` as MessageKey) : '',
    window.estimated ? t('quota.estimatedTip') : ''
  ].filter(Boolean).join('\n')
  const PaceIcon = pace ? PACE_ICON[pace.pace] : null
  const countdown = awaiting ? t('quota.resetDue') : resetAt !== undefined ? quotaCountdown(t, resetAt - now) : ''
  return (
    <div className="wb-quota-win" data-tone={tone} title={tip} data-testid={`v3-wb-quota-win-${window.id}`}>
      <span className="wb-quota-win-id">
        <span className="wb-quota-win-label">{name}</span>
        <span className="wb-quota-win-pct ui-num">
          {awaiting ? '—' : `${used}%`}
          <small>{t('quota.usedMain')}</small>
        </span>
        {PaceIcon && pace ? (
          <span className="wb-quota-win-pace" role="img" aria-label={t(`quota.pace.${pace.pace}` as MessageKey)}>
            <PaceIcon size={13} aria-hidden="true" />
          </span>
        ) : null}
      </span>
      <Meter
        aria-label={window.label}
        value={awaiting ? 0 : used}
        minValue={0}
        maxValue={100}
        tone={METER_TONE[tone]}
        variant="gauge"
        markPercent={pace ? 100 - pace.timeLeftPct : null}
        trailing={countdown ? <><RotateCcw size={11} aria-hidden="true" />{countdown}</> : undefined}
      />
    </div>
  )
}
