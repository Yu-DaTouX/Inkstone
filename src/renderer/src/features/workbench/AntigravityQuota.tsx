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
import { Badge, Card, Collapsible, CollapsibleHeader, CollapsiblePanel, IconButton, Notice, type RailTone } from '../../ui'
import { RefreshCw } from '../../ui/icons'
import { translate, useI18n, type Lang } from '../../i18n'
import { QuotaMeter } from './QuotaMeter'

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

function periodLabel(window: AntigravityQuotaWindow, lang: Lang): string {
  return window.period === '5h' ? '5h' : window.period === 'weekly' ? translate(lang, 'quota.ag.weekShort') : window.name
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
  const locale = lang === 'en-US' ? 'en-US' : 'zh-CN'
  const chosen = matchAntigravityGroup(groups, model)
  const summary = chosen
    ? orderedWindows(chosen).slice(0, 2).map((window) => `${periodLabel(window, locale)} ${percent(window.remainingFraction, lang)}`).join(' · ')
    : translate(locale, 'quota.ag.groups', { n: groups.length })
  return snapshot?.staleSince === undefined ? summary : `${summary} · ${translate(locale, 'quota.ag.stale')}`
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

function formatCountdown(ms: number, lang: Lang): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const d = Math.floor(total / 86400)
  const h = Math.floor((total % 86400) / 3600)
  const m = Math.floor((total % 3600) / 60)
  if (d > 0) return translate(lang, 'quota.ag.countdownDays', { d, h })
  if (h > 0) return translate(lang, 'quota.ag.countdownHours', { h, m })
  return translate(lang, 'quota.ag.countdownMinutes', { m: Math.max(1, m) })
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

export function AntigravityQuotaDetails({ quota, lang, model, now = Date.now() }: {
  quota: Pick<ReturnType<typeof useAntigravityQuota>, 'snapshot' | 'loading' | 'refresh'>
  lang: string
  model?: AntigravityModel
  now?: number
}): ReactElement {
  const { snapshot, loading, refresh } = quota
  const locale = lang === 'en-US' ? 'en-US' : 'zh-CN'
  const groups = snapshot?.groups ?? []
  const currentGroup = matchAntigravityGroup(groups, model)
  const stale = snapshot?.staleSince !== undefined
  const refreshLabel = translate(locale, 'quota.refresh')
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
          const countdown = resetAt !== undefined && !awaiting ? formatCountdown(resetAt - now, locale) : undefined
          return { window, name: periodLabel(window, locale), resetAt, awaiting, clock, countdown }
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
                {isCurrent ? <Badge tone="ok" className="wb-ov-qmain-plan">{translate(locale, 'quota.ag.current')}</Badge> : null}
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
                  ? translate(locale, 'quota.ag.reset')
                  : clock
                    ? (countdown
                        ? translate(locale, 'quota.ag.resetsWithCountdown', { clock, countdown })
                        : translate(locale, 'quota.ag.resetsAt', { clock }))
                    : undefined
                const tip = [
                  `${group.name} · ${name}`,
                  translate(locale, 'quota.ag.remaining', { left, used }),
                  clock ? translate(locale, 'quota.ag.resetsAt', { clock }) : ''
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
        <Notice tone="ask" compact>{translate(locale, 'quota.ag.showingLast', { error: snapshot.error })}</Notice>
      ) : null}
      {!groups.length ? (
        <div className="wb-ov-ctx-head">
          <Notice tone="ask" compact>{snapshot?.error ?? (loading
            ? translate(locale, 'quota.ag.checking')
            : translate(locale, 'quota.ag.unavailable'))}</Notice>
          {refreshButton}
        </div>
      ) : null}
    </div>
  )
}

export function AntigravityQuotaPaneSection({ snapshot, loading, active, model, now, icon }: {
  snapshot?: AntigravityQuotaSnapshot
  loading: boolean
  active: boolean
  model?: AntigravityModel
  now: number
  icon?: string | null
}): ReactElement | null {
  const { t } = useI18n()
  const groups = snapshot?.groups ?? []
  if (!active && !groups.length) return null
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
          {t('quota.ag.showingLast', { error: snapshot.error })}
        </Notice>
      ) : null}
      <Card as="section" padding="none" className="wb-quota-card" data-active={active ? '1' : undefined} data-testid="v3-wb-quota-card-antigravity">
        <div className="wb-quota-id">
          <span className="wb-quota-name">Antigravity CLI</span>
          {active && !currentGroup ? <Badge tone="ok" data-testid="v3-wb-quota-active">{t('acct.active')}</Badge> : null}
          {stale ? <Badge data-testid="v3-wb-quota-stale">{t('quota.ag.stale')}</Badge> : null}
        </div>
        {!groups.length ? (
          snapshot?.error ? (
            <p className="wb-quota-error" data-testid="v3-wb-quota-antigravity-error">{snapshot.error}</p>
          ) : (
            <p className="wb-quota-ag-note">
              {t(loading ? 'quota.ag.checking' : 'quota.ag.unavailable')}
            </p>
          )
        ) : groups.map((group, index) => {
          const exhausted = !stale && group.windows.some((window) =>
            window.remainingFraction <= 0 && (antigravityWindowResetAt(window) ?? Infinity) > now)
          const note = [group.models.join(' · '), group.description].filter(Boolean).join(' · ')
          const badges = currentGroup === group || exhausted ? (
            <>
              {currentGroup === group ? <Badge tone="ok" data-testid="v3-wb-quota-active">{t('acct.active')}</Badge> : null}
              {exhausted ? <Badge tone="fail">{t('quota.limitReached')}</Badge> : null}
            </>
          ) : null
          return (
            <section key={`${group.name}:${index}`} aria-label={group.name} className="wb-quota-ag-group" data-testid="v3-wb-quota-antigravity-subgroup">
              {note ? (
                <Collapsible>
                  <CollapsibleHeader size="compact" chevron="end" tone="emphasized" accessory={badges}>
                    {group.name}
                  </CollapsibleHeader>
                  <CollapsiblePanel>
                    <p className="wb-quota-ag-note">{note}</p>
                  </CollapsiblePanel>
                </Collapsible>
              ) : (
                <div className="wb-quota-id"><span className="wb-quota-name">{group.name}</span>{badges}</div>
              )}
              <div className="wb-quota-ag-wins">
                {orderedWindows(group).map((window) => {
                  const name = window.period === '5h' ? t('quota.win.fiveHour') : window.period === 'weekly' ? t('quota.win.thisWeek') : window.name
                  return (
                    <QuotaMeter
                      key={window.id}
                      window={{
                        id: window.id,
                        label: `${group.name} · ${name}`,
                        used: 100 - window.remainingFraction * 100,
                        total: 100,
                        resetAt: antigravityWindowResetAt(window),
                        durationMs: windowDurationMs(window)
                      }}
                      name={name}
                      stale={stale}
                      now={now}
                      t={t}
                    />
                  )
                })}
              </div>
            </section>
          )
        })}
      </Card>
    </section>
  )
}
