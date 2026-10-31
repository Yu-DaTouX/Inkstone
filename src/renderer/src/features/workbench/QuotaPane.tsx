import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { RefreshCw, Settings } from 'lucide-react'
import { useT, type MessageKey } from '../../i18n'
import { useStore } from '../../state/store'
import { LIVE_QUOTA_MIN_GAP_MS, LIVE_QUOTA_POLL_MS, publishAccountQuotaReport } from '../../state/live-quota'
import { Badge, Button, Card, EmptyState, IconButton, Notice, Spinner } from '../../ui'
import { money } from '../../../../shared/quota-mini'
import { quotaReadingStale } from '../../../../shared/quota-forecast'
import {
  accountCardTitle,
  orderAccountCardsForProvider,
  type AccountQuotaCard,
  type AccountQuotaReport,
  type AccountQuotaSource
} from '../../../../shared/account-quota'
import { QuotaWindowRow, quotaReadAgo } from '../../patterns/QuotaWindowRow'
import type { QuotaPaneProps } from './types'

const sourceKey = (source: AccountQuotaSource): MessageKey => `acct.source.${source}` as MessageKey
const planLabel = (value?: string): string => (value ? value.toUpperCase() : '')
const GROUP_KEYS = new Set(['openai-codex', 'anthropic', 'google'])

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

  const cards = orderAccountCardsForProvider(report?.cards ?? [], provider)
  const time = report
    ? new Date(report.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
    : ''

  return (
    <div className="wb-quota" data-testid="v3-wb-quota">
      <div className="wb-quota-head">
        <span className="wb-quota-checked" title={report ? t('quota.checkedAt', { time }) : undefined}>{report ? time : loading ? <Spinner label={t('quota.refresh')} size="sm" /> : null}</span>
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
      {notice ? <Notice compact>{notice}</Notice> : null}

      {groupByProvider(cards).map((group) => (
        <section key={group.provider} className="wb-quota-group" data-testid={`v3-wb-quota-group-${group.provider}`}>
          <header className="wb-quota-group-head">
            <span className="wb-quota-group-name">
              {GROUP_KEYS.has(group.provider) ? t(`quota.group.${group.provider}` as MessageKey) : group.provider}
            </span>
          </header>
          {group.cards.map((card) => (
            <QuotaCard key={`${card.source}:${card.key}`} card={card} busy={busyKey === card.key} locked={!!busyKey} onSwitch={() => void switchTo(card)} />
          ))}
        </section>
      ))}
      {report && cards.length === 0 ? (
        <EmptyState className="wb-note-block" data-testid="v3-wb-quota-empty" title={t('acct.emptyTitle')} description={t('acct.emptyBody')} />
      ) : null}

    </div>
  )
}

export function QuotaCard({
  card,
  busy,
  locked,
  onSwitch
}: {
  card: AccountQuotaCard
  busy: boolean
  locked: boolean
  onSwitch: () => void
}): ReactElement {
  const t = useT()
  const now = Date.now()
  const stale = quotaReadingStale(card.checkedAt, now, !!card.staleError)
  const title = accountCardTitle(card)
  const meta = [
    title !== card.email ? card.email : '',
    card.source !== 'yan' ? t(sourceKey(card.source)) : '',
    card.alsoIn?.length ? t('acct.alsoIn', { list: card.alsoIn.map((source) => t(sourceKey(source))).join('、') }) : ''
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <Card as="section" className="wb-quota-card" data-active={card.active ? '1' : undefined} data-limited={card.status === 'limited' ? '1' : undefined} data-testid={`v3-wb-quota-card-${card.source}-${card.provider}`}>
      <div className="wb-quota-id">
        <span className="wb-quota-name" title={[card.label, card.email].filter(Boolean).join(' · ') || undefined}>
          {title}
        </span>
        {card.plan ? <Badge tone="accent" data-testid="v3-wb-quota-plan">{planLabel(card.plan)}</Badge> : null}
        {card.status === 'expired' ? <span title={card.hint || t('quota.expiredTip')}><Badge tone="ask">{t('quota.expiredBadge')}</Badge></span> : null}
        {card.active ? <Badge tone="ok">{t('acct.active')}</Badge> : null}
        {card.status === 'limited' ? <Badge tone="fail">{t('quota.limitReached')}</Badge> : null}
        {card.switchable && !card.active ? (
          <Button size="sm" variant="secondary" isDisabled={locked} icon={busy ? <Spinner size="xs" /> : undefined} onPress={onSwitch} data-testid="v3-wb-quota-switch">
            {t('acct.switch')}
          </Button>
        ) : null}
      </div>
      {meta ? <div className="wb-quota-meta" title={meta}>{meta}</div> : null}

      {card.status === 'error' ? <Notice tone="fail" compact>{t('acct.failed', { msg: card.error ?? '' })}</Notice> : null}

      {stale && (card.windows.length || card.balance) ? (
        <span className="wb-quota-stale" title={[t('quota.staleTip'), card.staleError ? t('quota.readFailed', { msg: card.staleError }) : ''].filter(Boolean).join(" · ")} data-testid="v3-wb-quota-stale">
          <Badge>{quotaReadAgo(t, card.checkedAt, now)}</Badge>
        </span>
      ) : null}

      {card.windows.map((window) => (
        <QuotaWindowRow key={window.id} window={window} stale={stale} now={now} detail testId={`v3-wb-quota-win-${window.id}`} />
      ))}
      {card.balance ? (
        <div className="quota-win" data-tone={stale ? 'stale' : 'ok'}>
          <div className="quota-win-top">
            <span className="quota-win-label">{card.balance.label}</span>
            <span className="quota-win-value ui-meta-num">{money(card.balance.amount, card.balance.currency)}</span>
          </div>
        </div>
      ) : null}
    </Card>
  )
}
