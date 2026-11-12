import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { Gauge, RefreshCw, RotateCcw, Settings, Ticket, TrendingDown, TrendingUp, type LucideIcon } from 'lucide-react'
import { currentLang, useT, type MessageKey, type TFunc } from '../../i18n'
import { useStore } from '../../state/store'
import { LIVE_QUOTA_MIN_GAP_MS, LIVE_QUOTA_POLL_MS, publishAccountQuotaReport } from '../../state/live-quota'
import { Badge, Button, Card, ConfirmDialog, EmptyState, IconButton, Meter, Notice, Spinner, type ProgressTone } from '../../ui'
import { money } from '../../../../shared/quota-mini'
import { quotaReadingStale, windowAwaitingReset, windowUsedPct } from '../../../../shared/quota-forecast'
import type { QuotaWindow } from '../../../../shared/ipc'
import {
  accountCardTitle,
  orderAccountCardsForProvider,
  type AccountQuotaCard,
  type AccountQuotaReport,
  type AccountQuotaSource,
  type ResetCreditGroup
} from '../../../../shared/account-quota'
import { providerFavicon } from '../../patterns/provider-favicon'
import { quotaCountdown, quotaPace, quotaReadAgo, quotaWindowName, quotaWindowTone, type QuotaWindowTone } from '../../patterns/QuotaWindowRow'
import type { QuotaPaneProps } from './types'

const sourceKey = (source: AccountQuotaSource): MessageKey => `acct.source.${source}` as MessageKey
const planLabel = (value?: string): string => (value ? value.toUpperCase() : '')
const GROUP_KEYS = new Set(['openai-codex', 'anthropic', 'google'])
const METER_TONE: Record<QuotaWindowTone, ProgressTone> = { ok: 'muted', ask: 'ask', fail: 'fail', stale: 'muted' }
const PACE_ICON: Record<'ahead' | 'on' | 'under', LucideIcon> = { ahead: TrendingUp, on: Gauge, under: TrendingDown }

const pad = (value: number): string => String(value).padStart(2, '0')

function claudeCreditLimitName(t: TFunc, id: string): string {
  if (id === 'five_hour') return t('quota.win.fiveHour')
  if (id === 'seven_day') return t('quota.win.thisWeek')
  if (id === 'seven_day_opus') return 'Opus'
  if (id === 'seven_day_sonnet') return 'Sonnet'
  if (id === 'seven_day_overage_included') return 'Fable'
  return t('quota.credit.limits')
}

function clockAt(at: number, now: number): string {
  const date = new Date(at)
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  return date.toDateString() === new Date(now).toDateString() ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`
}

function groupByProvider(cards: AccountQuotaCard[]): { provider: string; cards: AccountQuotaCard[] }[] {
  const groups: { provider: string; cards: AccountQuotaCard[] }[] = []
  for (const card of cards) {
    const group = groups.find((entry) => entry.provider === card.provider)
    if (group) group.cards.push(card)
    else groups.push({ provider: card.provider, cards: [card] })
  }
  return groups
}

export function QuotaPane({ visible = true }: QuotaPaneProps): ReactElement {
  const t = useT()
  const provider = useStore((s) => s.session?.model?.provider ?? '')
  const authProviders = useStore((s) => s.authProviders)
  const [report, setReport] = useState<AccountQuotaReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const checkedAt = useRef(0)
  const alive = useRef(true)
  const loadId = useRef(0)
  const [, setTick] = useState(0)

  const load = useCallback(async () => {
    const requestId = ++loadId.current
    setLoading(true)
    try {
      const next = await window.yan.accountQuota()
      if (!alive.current || requestId !== loadId.current) return
      publishAccountQuotaReport(next)
      setReport(next)
      setError('')
      checkedAt.current = next.checkedAt
    } catch (cause) {
      if (alive.current && requestId === loadId.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (alive.current && requestId === loadId.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!visible) return undefined
    alive.current = true
    void load()
    const tick = setInterval(() => setTick((value) => value + 1), 30_000)
    const poll = setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, LIVE_QUOTA_POLL_MS)
    const onFocus = (): void => {
      if (document.visibilityState === 'visible' && Date.now() - checkedAt.current >= LIVE_QUOTA_MIN_GAP_MS) void load()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      alive.current = false
      loadId.current += 1
      clearInterval(tick)
      clearInterval(poll)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [load, authProviders, visible])

  const switchTo = async (card: AccountQuotaCard): Promise<void> => {
    setBusyKey(card.key)
    setNotice('')
    try {
      const result = card.provider === 'openai-codex'
        ? await window.yan.codexAccountSwitch(card.key)
        : await window.yan.oauthAccountSwitch(card.provider, card.key)
      if (!alive.current) return
      setNotice(result.ok ? t('acct.switched', { name: accountCardTitle(card) }) : t('acct.failed', { msg: result.error ?? '' }))
      if (result.ok) await load()
    } catch (cause) {
      if (alive.current) setNotice(t('acct.failed', { msg: cause instanceof Error ? cause.message : String(cause) }))
    } finally {
      if (alive.current) setBusyKey(null)
    }
  }

  const redeem = async (card: AccountQuotaCard, creditId: string): Promise<void> => {
    if (!creditId) return
    setBusyKey(card.key)
    setNotice('')
    try {
      const result = await window.yan.accountResetCredit(card.provider, card.key, creditId)
      if (!alive.current) return
      setNotice(result.ok && result.outcome ? t(`quota.credit.${result.outcome}` as MessageKey) : t('acct.failed', { msg: result.error ?? '' }))
      if (result.ok) await load()
    } catch (cause) {
      if (alive.current) setNotice(t('acct.failed', { msg: cause instanceof Error ? cause.message : String(cause) }))
    } finally {
      if (alive.current) setBusyKey(null)
    }
  }

  const cards = orderAccountCardsForProvider(report?.cards ?? [], provider)
  const groups = groupByProvider(cards)
  const time = report
    ? new Date(report.checkedAt).toLocaleTimeString(currentLang(), { hour: '2-digit', minute: '2-digit', hour12: false })
    : ''

  return (
    <div className="wb-quota" data-testid="v3-wb-quota">
      <div className="wb-quota-head">
        <span className="wb-quota-checked">{report ? t('quota.checkedAt', { time }) : loading ? <Spinner label={t('quota.refresh')} size="sm" /> : null}</span>
        <span className="wb-quota-actions">
          <IconButton
            size="sm"
            variant="ghost"
            aria-label={t('quota.refresh')}
            tooltip={t('quota.refresh')}
            onPress={() => void load()}
            isDisabled={loading}
            data-testid="v3-wb-quota-refresh"
          >
            <RefreshCw size={14} />
          </IconButton>
          <IconButton
            size="sm"
            variant="ghost"
            aria-label={t('quota.settings')}
            tooltip={t('quota.settings')}
            onPress={() => useStore.getState().openSettings('models')}
            data-testid="v3-wb-quota-settings"
          >
            <Settings size={14} />
          </IconButton>
        </span>
      </div>
      {error ? (
        <Notice tone="fail" compact data-testid="v3-wb-quota-error">
          {report ? t('quota.stale', { msg: error }) : t('acct.failed', { msg: error })}
        </Notice>
      ) : null}
      {notice ? <Notice compact data-testid="v3-wb-quota-notice">{notice}</Notice> : null}

      {groups.map((group) => {
        const icon = providerFavicon(group.provider)
        const groupName = GROUP_KEYS.has(group.provider) ? t(`quota.group.${group.provider}` as MessageKey) : group.cards[0]?.name ?? group.provider
        const solo = group.cards.length === 1 && accountCardTitle(group.cards[0]) === groupName
        return (
          <section key={group.provider} className="wb-quota-group" aria-label={solo ? groupName : undefined} data-testid={`v3-wb-quota-group-${group.provider}`}>
            {solo ? null : (
              <header className="wb-quota-group-head">
                {icon ? <img className="wb-quota-group-icon" src={icon} alt="" aria-hidden="true" /> : null}
                <span className="wb-quota-group-name">{groupName}</span>
              </header>
            )}
            {group.cards.map((card) => (
              <QuotaCard
                key={`${card.source}:${card.key}`}
                card={card}
                icon={solo ? icon : null}
                busy={busyKey === card.key}
                locked={!!busyKey}
                onSwitch={() => void switchTo(card)}
                onRedeem={(creditId) => redeem(card, creditId)}
              />
            ))}
          </section>
        )
      })}
      {report && cards.length === 0 ? (
        <EmptyState
          className="wb-note-block"
          data-testid="v3-wb-quota-empty"
          title={t('acct.emptyTitle')}
          action={
            <Button size="sm" variant="secondary" onPress={() => useStore.getState().openSettings('models')} data-testid="v3-wb-quota-empty-settings">
              {t('quota.emptyAction')}
            </Button>
          }
        />
      ) : null}
    </div>
  )
}

function QuotaMeter({ window, name, stale, now, t }: { window: QuotaWindow; name: string; stale: boolean; now: number; t: TFunc }): ReactElement {
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

export function QuotaCard({
  card,
  busy,
  locked,
  onSwitch,
  onRedeem,
  icon = null
}: {
  card: AccountQuotaCard
  icon?: string | null
  busy: boolean
  locked: boolean
  onSwitch: () => void
  onRedeem: (creditId: string) => Promise<void>
}): ReactElement {
  const t = useT()
  const [confirming, setConfirming] = useState<ResetCreditGroup | null>(null)
  const now = Date.now()
  const stale = quotaReadingStale(card.checkedAt, now, !!card.staleError)
  const title = accountCardTitle(card)
  const tip = [
    card.label,
    card.email,
    card.source !== 'yan' ? t(sourceKey(card.source)) : '',
    card.alsoIn?.length ? t('acct.alsoIn', { list: card.alsoIn.map((source) => t(sourceKey(source))).join('、') }) : ''
  ]
    .filter(Boolean)
    .join(' · ')
  const credits = card.resetCredits
  const shortNames = card.windows.map((window) => quotaWindowName(t, window))
  const names = shortNames.map((name, index) => (shortNames.indexOf(name) === shortNames.lastIndexOf(name) ? name : card.windows[index].label))
  const creditGroups = credits?.groups ?? (credits ? [credits] : [])
  const creditName = (group: ResetCreditGroup): string => t(`quota.credit.kind.${group.kind ?? 'default'}` as MessageKey)
  const confirmedGroup = creditGroups.find((group) => group.nextId && group.nextId === confirming?.nextId)
  const confirmLimits = confirming?.clears?.map((id) => claudeCreditLimitName(t, id)).join('、') || t('quota.credit.limits')

  return (
    <Card as="section" padding="none" className="wb-quota-card" data-active={card.active ? '1' : undefined} data-limited={card.status === 'limited' ? '1' : undefined} data-testid={`v3-wb-quota-card-${card.source}-${card.provider}`}>
      <div className="wb-quota-id">
        {icon ? <img className="wb-quota-group-icon" src={icon} alt="" aria-hidden="true" /> : null}
        <span className="wb-quota-name" title={tip || undefined}>{title}</span>
        {card.plan ? <Badge tone="accent" data-testid="v3-wb-quota-plan">{planLabel(card.plan)}</Badge> : null}
        {card.active ? <Badge tone="ok" data-testid="v3-wb-quota-active">{t('acct.active')}</Badge> : null}
        {stale && (card.windows.length || card.balance) ? (
          <span title={[t('quota.staleTip'), card.staleError ? t('quota.readFailed', { msg: card.staleError }) : ''].filter(Boolean).join(' · ')} data-testid="v3-wb-quota-stale">
            <Badge>{quotaReadAgo(t, card.checkedAt, now)}</Badge>
          </span>
        ) : null}
        {card.status === 'expired' ? <span title={card.hint || t('quota.expiredTip')}><Badge tone="ask">{t('quota.expiredBadge')}</Badge></span> : null}
        {card.status === 'limited' ? <Badge tone="fail">{t('quota.limitReached')}</Badge> : null}
        {card.switchable && !card.active ? (
          <Button size="sm" variant="secondary" isDisabled={locked} icon={busy && !confirming ? <Spinner size="xs" /> : undefined} onPress={onSwitch} data-testid="v3-wb-quota-switch">
            {t('acct.switch')}
          </Button>
        ) : null}
      </div>

      {card.status === 'error' ? <p className="wb-quota-error" title={card.error ?? undefined}>{card.error}</p> : null}

      {card.windows.length ? (
        <div className="wb-quota-wins">
          {card.windows.map((window, index) => (
            <QuotaMeter key={window.id} window={window} name={names[index]} stale={stale} now={now} t={t} />
          ))}
        </div>
      ) : null}
      {card.balance ? (
        <div className="wb-quota-balance" data-tone={stale ? 'stale' : 'ok'}>
          <span className="wb-quota-win-label">{card.balance.label}</span>
          <span className="wb-quota-balance-value ui-meta-num">{money(card.balance.amount, card.balance.currency)}</span>
        </div>
      ) : null}

      {creditGroups.filter((group) => group.count > 0).map((group) => {
        const name = creditName(group)
        const expired = group.nextExpiresAt !== undefined && group.nextExpiresAt <= now
        const available = !!group.nextId && !expired && !stale
        const expiry = group.nextExpiresAt !== undefined ? t('quota.credit.expireIn', { t: quotaCountdown(t, group.nextExpiresAt - now) }) : ''
        return (
          <div key={group.kind ?? 'default'} className="wb-quota-credits" data-testid="v3-wb-quota-credits" data-credit-kind={group.kind ?? 'default'} title={[name, expiry, available ? '' : t('quota.credit.unavailable')].filter(Boolean).join(' · ')}>
            <Ticket size={13} aria-hidden="true" />
            <span className="wb-quota-credits-count">{name} <span className="ui-num">×{group.count}</span></span>
            <span className="wb-quota-credits-exp ui-meta-num">{expiry}</span>
            <Button className="wb-quota-credits-use" size="sm" variant="secondary" isDisabled={locked || !available} icon={busy && confirming?.kind === group.kind ? <Spinner size="xs" /> : undefined} onPress={() => setConfirming({ ...group })} data-testid="v3-wb-quota-credit-use" aria-label={t('quota.credit.useKind', { kind: name })}>
              {available ? t('quota.credit.use') : t('quota.credit.unavailable')}
            </Button>
          </div>
        )
      })}
      <ConfirmDialog
        isOpen={confirming !== null}
        onOpenChange={(open) => { if (!open) setConfirming(null) }}
        title={t('quota.credit.confirmTitle', { kind: confirming ? creditName(confirming) : '' })}
        description={t(confirming?.kind === 'fable' ? 'quota.credit.confirmFableDesc' : 'quota.credit.confirmDesc', { name: title, limits: confirmLimits })}
        confirmLabel={t('quota.credit.confirmUse')}
        tone="danger"
        isConfirmDisabled={locked || stale || !confirmedGroup || (confirmedGroup.nextExpiresAt !== undefined && confirmedGroup.nextExpiresAt <= now)}
        onConfirm={() => { if (confirmedGroup?.nextId && confirming?.nextId === confirmedGroup.nextId) return onRedeem(confirming.nextId) }}
        confirmTestId="v3-wb-quota-credit-confirm"
      />
    </Card>
  )
}
