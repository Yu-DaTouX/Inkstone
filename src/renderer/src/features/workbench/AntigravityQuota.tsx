import { useCallback, useEffect, type ReactElement } from 'react'
import {
  ANTIGRAVITY_QUOTA_REFRESH_MS,
  antigravityWindowResetAt,
  type AntigravityModel,
  type AntigravityQuotaGroup,
  type AntigravityQuotaSnapshot,
  type AntigravityQuotaWindow
} from '../../../../shared/antigravity'
import { WINDOW_DURATION } from '../../../../shared/quota-forecast'
import { refreshAntigravityQuota, useAntigravityQuotaStore } from '../../state/antigravity-quota'
import { Badge, Card, IconButton, Meter, Notice, type ProgressTone, type RailTone } from '../../ui'
import { Gauge, RefreshCw, RotateCcw, TrendingDown, TrendingUp, type LucideIcon } from '../../ui/icons'

const METER_TONE: Record<'ok' | 'ask' | 'fail' | 'stale', ProgressTone> = { ok: 'muted', ask: 'ask', fail: 'fail', stale: 'muted' }
const PACE_ICON: Record<'ahead' | 'on' | 'under', LucideIcon> = { ahead: TrendingUp, on: Gauge, under: TrendingDown }

export function useAntigravityQuota(enabled: boolean, running: boolean) {
  const snapshot = useAntigravityQuotaStore((s) => s.snapshot)
  const loading = useAntigravityQuotaStore((s) => s.loading)
  const refresh = useCallback((force = false) => refreshAntigravityQuota(force), [])

  useEffect(() => {
    if (enabled && !running) void refresh()
  }, [enabled, running, refresh])
  useEffect(() => {
    if (!enabled) return undefined
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, ANTIGRAVITY_QUOTA_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [enabled, refresh])

  return { snapshot, loading, refresh }
}

function percent(fraction: number, lang: string): string {
  if (fraction > 0 && fraction < 0.001) return '<0.1%'
  return new Intl.NumberFormat(lang, { style: 'percent', maximumFractionDigits: 1 }).format(fraction)
}

function periodLabel(window: AntigravityQuotaWindow, en: boolean): string {
  return window.period === '5h' ? '5h' : window.period === 'weekly' ? (en ? 'Wk' : '每周') : window.name
}

function detailPeriodLabel(window: AntigravityQuotaWindow, en: boolean): string {
  return window.period === '5h' ? (en ? '5-hour' : '5 小时') : window.period === 'weekly' ? (en ? 'This week' : '本周') : window.name
}

function windowDurationMs(window: AntigravityQuotaWindow): number | undefined {
  if (window.period === '5h') return WINDOW_DURATION.fiveHour
  if (window.period === 'weekly') return WINDOW_DURATION.week
  return undefined
}

function orderedWindows(group: AntigravityQuotaGroup): AntigravityQuotaWindow[] {
  return [...group.windows.filter(({ period }) => period === '5h'), ...group.windows.filter(({ period }) => period !== '5h')]
}

function matchKey(name: string): string {
  return name.trim().toLowerCase().replace(/[\s._-]+/g, '-')
}

function matchAntigravityGroup(groups: readonly AntigravityQuotaGroup[], model: AntigravityModel | undefined): AntigravityQuotaGroup | undefined {
  if (!groups.length || !model) return undefined
  const keys = new Set([model.id, model.name].filter((value): value is string => !!value).map(matchKey))
  if (!keys.size) return undefined
  return groups.find((group) => keys.has(matchKey(group.name)))
    ?? groups.find((group) => group.models.some((name) => keys.has(matchKey(name))))
}

export function antigravityQuotaSummary(snapshot: AntigravityQuotaSnapshot | undefined, model: AntigravityModel | undefined, lang: string): string | undefined {
  const groups = snapshot?.groups
  if (!groups?.length) return undefined
  const en = lang === 'en-US'
  const chosen = matchAntigravityGroup(groups, model)
  const summary = chosen
    ? orderedWindows(chosen).slice(0, 2).map((window) => `${periodLabel(window, en)} ${percent(window.remainingFraction, lang)}`).join(' · ')
    : en ? `${groups.length} groups` : `${groups.length} 组`
  return snapshot?.staleSince === undefined ? summary : `${summary} · ${en ? 'Stale' : '旧数据'}`
}

export function antigravityQuotaTone(snapshot: AntigravityQuotaSnapshot | undefined, model: AntigravityModel | undefined): RailTone | undefined {
  const groups = snapshot?.groups
  if (!groups?.length || snapshot?.staleSince !== undefined) return undefined
  const chosen = matchAntigravityGroup(groups, model)
  const windows = chosen ? chosen.windows : groups.flatMap((group) => group.windows)
  if (windows.some((window) => window.remainingFraction <= 0)) return 'fail'
  if (windows.some((window) => window.remainingFraction <= 0.2)) return 'ask'
  return undefined
}

function windowTone(fraction: number): 'ok' | 'ask' | 'fail' {
  if (fraction <= 0) return 'fail'
  if (fraction <= 0.2) return 'ask'
  return 'ok'
}

function formatCountdown(ms: number, en: boolean): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const d = Math.floor(total / 86400)
  const h = Math.floor((total % 86400) / 3600)
  const m = Math.floor((total % 3600) / 60)
  if (d > 0) return en ? `${d}d ${h}h` : `${d}天${h}时`
  if (h > 0) return en ? `${h}h ${m}m` : `${h}时${m}分`
  const mins = Math.max(1, m)
  return en ? `${mins}m` : `${mins}分`
}

function shortReset(resetAt: number | undefined, lang: string, now: number): string | undefined {
  if (resetAt === undefined || !Number.isFinite(resetAt)) return undefined
  const date = new Date(resetAt)
  if (!Number.isFinite(date.getTime())) return undefined
  const sameDay = date.toDateString() === new Date(now).toDateString()
  return new Intl.DateTimeFormat(lang, {
    ...(sameDay ? {} : { month: 'numeric', day: 'numeric' }),
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).format(date)
}

function windowPace(window: AntigravityQuotaWindow, resetAt: number | undefined, now: number): { pace: 'ahead' | 'on' | 'under'; timeLeftPct: number } | null {
  const durationMs = windowDurationMs(window)
  if (!durationMs || resetAt === undefined || resetAt <= now || window.remainingFraction >= 1) return null
  const leftRatio = Math.max(0, Math.min(1, (resetAt - now) / durationMs))
  const timeLeftPct = Math.min(99, Math.max(1, Math.round(leftRatio * 100)))
  const gap = leftRatio * 100 - window.remainingFraction * 100
  return { pace: gap > 5 ? 'ahead' : gap < -5 ? 'under' : 'on', timeLeftPct }
}

function paceText(pace: 'ahead' | 'on' | 'under', en: boolean): string {
  if (pace === 'ahead') return en ? 'ahead of pace' : '用得偏快'
  if (pace === 'under') return en ? 'under pace' : '用得偏慢'
  return en ? 'on pace' : '节奏正常'
}

export function AntigravityQuotaDetails({ quota, lang, model, now = Date.now() }: {
  quota: Pick<ReturnType<typeof useAntigravityQuota>, 'snapshot' | 'loading' | 'refresh'>
  lang: string
  model?: AntigravityModel
  now?: number
}): ReactElement {
  const { snapshot, loading, refresh } = quota
  const en = lang === 'en-US'
  const groups = snapshot?.groups ?? []
  const currentGroup = matchAntigravityGroup(groups, model)
  const stale = snapshot?.staleSince !== undefined
  const refreshLabel = en ? 'Refresh quota' : '刷新额度'
  const refreshButton = (
    <IconButton
      size="sm"
      variant="ghost"
      aria-label={refreshLabel}
      tooltip={refreshLabel}
      data-testid="antigravity-quota-refresh"
      isDisabled={loading}
      isPending={loading}
      onPress={() => void refresh(true)}
    >
      <RefreshCw size={12} aria-hidden />
    </IconButton>
  )
  return (
    <div className="wb-ov-quota" data-testid="rail-antigravity-quota">
      {groups.map((group, index) => {
        const isCurrent = currentGroup === group
        const windows = orderedWindows(group).map((window) => {
          const resetAt = antigravityWindowResetAt(window)
          const awaiting = resetAt !== undefined && resetAt <= now
          const clock = shortReset(resetAt, lang, now)
          const countdown = resetAt !== undefined && !awaiting ? formatCountdown(resetAt - now, en) : undefined
          return { window, name: periodLabel(window, en), resetAt, awaiting, clock, countdown }
        })
        const groupTip = [
          group.models.length ? `${group.name}: ${group.models.join(', ')}` : group.name,
          group.description ?? ''
        ].filter(Boolean).join('\n')
        return (
          <div key={`${group.name}:${index}`} className="wb-ov-qmain" data-current={isCurrent ? '1' : undefined} title={groupTip}>
            <div className="wb-ov-ctx-head">
              <span className="wb-ov-qmain-name">
                <span className="wb-ov-qmain-label">{group.name}</span>
                {isCurrent ? <Badge tone="ok" className="wb-ov-qmain-plan">{en ? 'Current' : '当前'}</Badge> : null}
              </span>
              {index === 0 ? <span className="wb-ov-qmain-side">{refreshButton}</span> : null}
            </div>
            <ul className="wb-ov-qminis">
              {windows.map(({ window, name, awaiting, clock, countdown }) => {
                const remaining = Math.round(Math.min(100, Math.max(0, window.remainingFraction * 100)))
                const used = Math.round(Math.min(100, Math.max(0, (1 - window.remainingFraction) * 100)))
                const left = percent(window.remainingFraction, lang)
                const full = window.remainingFraction >= 1
                const tone = stale || awaiting ? 'stale' : windowTone(window.remainingFraction)
                const resetLine = awaiting
                  ? (en ? 'Reset' : '已重置')
                  : clock
                    ? (countdown
                        ? (en ? `Resets ${clock} · in ${countdown}` : `重置 ${clock} · ${countdown}后`)
                        : (en ? `Resets ${clock}` : `重置 ${clock}`))
                    : undefined
                const tip = [
                  `${group.name} · ${name}`,
                  `${en ? 'Remaining' : '剩余'} ${left} (${used}% ${en ? 'used' : '已用'})`,
                  clock ? `${en ? 'Resets' : '重置'} ${clock}` : ''
                ].filter(Boolean).join('\n')
                return (
                  <li key={window.id} className="wb-ov-qmini wb-ov-ag-row" data-tone={tone} data-full={full ? '1' : undefined} title={tip}>
                    <span className="wb-ov-qmini-name">{name}</span>
                    <div className="wb-ov-ctx-meter">
                      <div className="wb-ctx-bar" role="img" aria-label={`${group.name} ${name} ${left}`}>
                        {remaining > 0 ? <i className="wb-ov-qfill" style={{ width: `${remaining}%` }} /> : null}
                      </div>
                    </div>
                    <span className="wb-ov-qmini-num">{left}</span>
                    {resetLine ? <span className="wb-ov-ag-reset">{resetLine}</span> : null}
                  </li>
                )
              })}
            </ul>
          </div>
        )
      })}
      {stale && snapshot?.error ? (
        <Notice tone="ask" compact>{en ? 'Showing the last successful allowance. ' : '正在显示上次成功查询的额度。'}{snapshot.error}</Notice>
      ) : null}
      {!groups.length ? (
        <div className="wb-ov-ctx-head">
          <Notice tone="ask" compact>{snapshot?.error ?? (loading
            ? (en ? 'Checking allowance…' : '正在查询额度…')
            : (en ? 'Allowance unavailable.' : '暂时无法读取额度。'))}</Notice>
          {refreshButton}
        </div>
      ) : null}
    </div>
  )
}

export function AntigravityQuotaPaneSection({ snapshot, loading, active, model, now, lang, icon }: {
  snapshot?: AntigravityQuotaSnapshot
  loading: boolean
  active: boolean
  model?: AntigravityModel
  now: number
  lang: string
  icon?: string | null
}): ReactElement | null {
  const groups = snapshot?.groups ?? []
  if (!active && !groups.length) return null
  const en = lang === 'en-US'
  const stale = snapshot?.staleSince !== undefined
  const currentGroup = active ? matchAntigravityGroup(groups, model) : undefined

  return (
    <section className="wb-quota-group" data-testid="v3-wb-quota-group-antigravity">
      <header className="wb-quota-group-head">
        {icon ? <img className="wb-quota-group-icon" src={icon} alt="" aria-hidden="true" /> : null}
        <span className="wb-quota-group-name">Antigravity</span>
      </header>
      {stale && snapshot?.error ? (
        <Notice tone="ask" compact data-testid="v3-wb-quota-antigravity-stale">
          {en ? 'Showing the last successful allowance. ' : '正在显示上次成功查询的额度。'}{snapshot.error}
        </Notice>
      ) : null}
      {!groups.length ? (
        <Card as="section" padding="none" className="wb-quota-card" data-active={active ? '1' : undefined} data-testid="v3-wb-quota-card-antigravity">
          <div className="wb-quota-id">
            <span className="wb-quota-name">Antigravity CLI</span>
            {active ? <Badge tone="ok">{en ? 'Active' : '使用中'}</Badge> : null}
          </div>
          {snapshot?.error ? (
            <p className="wb-quota-error" data-testid="v3-wb-quota-antigravity-error">{snapshot.error}</p>
          ) : (
            <p className="wb-quota-ag-note">
              {loading ? (en ? 'Checking allowance…' : '正在查询额度…') : (en ? 'Allowance unavailable.' : '暂时无法读取额度。')}
            </p>
          )}
        </Card>
      ) : (
        groups.map((group, index) => {
          const isCurrent = currentGroup === group
          const exhausted = !stale && group.windows.some((window) => window.remainingFraction <= 0)
          const note = group.models.length ? group.models.join(' · ') : group.description
          const windows = orderedWindows(group)
          return (
            <Card
              key={`${group.name}:${index}`}
              as="section"
              padding="none"
              className="wb-quota-card"
              data-active={isCurrent ? '1' : undefined}
              data-limited={exhausted ? '1' : undefined}
              data-testid="v3-wb-quota-card-antigravity"
            >
              <div className="wb-quota-id">
                <span className="wb-quota-name">{group.name}</span>
                {isCurrent ? <Badge tone="ok" data-testid="v3-wb-quota-active">{en ? 'Active' : '使用中'}</Badge> : null}
                {stale ? <Badge data-testid="v3-wb-quota-stale">{en ? 'Stale' : '旧数据'}</Badge> : null}
                {exhausted ? <Badge tone="fail">{en ? 'Limit reached' : '已用完'}</Badge> : null}
              </div>
              {note ? <p className="wb-quota-ag-note">{note}</p> : null}
              <div className="wb-quota-wins">
                {windows.map((window) => {
                  const resetAt = antigravityWindowResetAt(window)
                  const awaiting = resetAt !== undefined && resetAt <= now
                  const remaining = Math.round(Math.min(100, Math.max(0, window.remainingFraction * 100)))
                  const used = Math.round(Math.min(100, Math.max(0, (1 - window.remainingFraction) * 100)))
                  const left = percent(window.remainingFraction, lang)
                  const base: 'ok' | 'ask' | 'fail' | 'stale' = stale || awaiting ? 'stale' : windowTone(window.remainingFraction)
                  const pace = stale || awaiting || base === 'fail' ? null : windowPace(window, resetAt, now)
                  const tone: 'ok' | 'ask' | 'fail' | 'stale' = base === 'ok' && pace?.pace === 'ahead' ? 'ask' : base
                  const clock = shortReset(resetAt, lang, now)
                  const countdown = awaiting ? (en ? 'Reset' : '已重置') : resetAt !== undefined ? formatCountdown(resetAt - now, en) : ''
                  const PaceIcon = pace ? PACE_ICON[pace.pace] : null
                  const tip = [
                    `${group.name} · ${detailPeriodLabel(window, en)}`,
                    `${en ? 'Remaining' : '剩余'} ${left} (${used}% ${en ? 'used' : '已用'})`,
                    clock ? `${en ? 'Resets at' : '重置于'} ${clock}` : '',
                    pace ? paceText(pace.pace, en) : ''
                  ].filter(Boolean).join('\n')
                  return (
                    <div key={window.id} className="wb-quota-win" data-tone={tone} title={tip} data-testid={`v3-wb-quota-win-${window.id}`}>
                      <span className="wb-quota-win-id">
                        <span className="wb-quota-win-label">
                          {detailPeriodLabel(window, en)}
                          {clock && !awaiting ? <span className="wb-quota-ag-clock"> · {clock}</span> : null}
                        </span>
                        <span className="wb-quota-win-pct ui-num">
                          {left}
                          <small>{en ? 'left' : '剩余'}</small>
                        </span>
                        {PaceIcon && pace ? (
                          <span className="wb-quota-win-pace" role="img" aria-label={paceText(pace.pace, en)}>
                            <PaceIcon size={13} aria-hidden="true" />
                          </span>
                        ) : null}
                      </span>
                      <Meter
                        aria-label={`${group.name} ${detailPeriodLabel(window, en)} ${left}`}
                        value={remaining}
                        minValue={0}
                        maxValue={100}
                        tone={METER_TONE[tone]}
                        variant="gauge"
                        markPercent={pace && (!countdown || pace.timeLeftPct <= 72) ? pace.timeLeftPct : null}
                        trailing={countdown ? <><RotateCcw size={11} aria-hidden="true" />{countdown}</> : undefined}
                      />
                    </div>
                  )
                })}
              </div>
            </Card>
          )
        })
      )}
    </section>
  )
}
