import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { RefreshCw } from 'lucide-react'
import { useI18n, useT, type MessageKey } from '../../i18n'
import { useStore } from '../../state/store'
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
import { workbenchPaneText } from './pane-text'
import type { QuotaPaneProps } from './types'

const AUTO_REFRESH_MS = 5 * 60_000

const sourceKey = (source: AccountQuotaSource): MessageKey => `acct.source.${source}` as MessageKey
const cap = (value?: string): string => (value ? value.charAt(0).toUpperCase() + value.slice(1) : '')

export function QuotaPane(_props: QuotaPaneProps): ReactElement {
  const t = useT()
  const { lang } = useI18n()
  const text = workbenchPaneText(lang)
  const provider = useStore((s) => s.session?.model?.provider ?? '')
  const [report, setReport] = useState<AccountQuotaReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const checkedAt = useRef(0)
  const alive = useRef(true)
  const [, setTick] = useState(0)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const next = await window.yan.accountQuota()
      if (!alive.current) return
      setReport(next)
      setError('')
      checkedAt.current = next.checkedAt
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    alive.current = true
    void load()
    const tick = setInterval(() => setTick((value) => value + 1), 30_000)
    const poll = setInterval(() => {
      if (document.visibilityState === 'visible' && Date.now() - checkedAt.current >= AUTO_REFRESH_MS) void load()
    }, 60_000)
    const onFocus = (): void => {
      if (Date.now() - checkedAt.current >= AUTO_REFRESH_MS) void load()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      alive.current = false
      clearInterval(tick)
      clearInterval(poll)
      window.removeEventListener('focus', onFocus)
    }
  }, [load])

  const switchTo = async (card: AccountQuotaCard): Promise<void> => {
    setBusyKey(card.key)
    setNotice('')
    try {
      const result = await window.yan.codexAccountSwitch(card.key)
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
        <span className="wb-quota-checked">{report ? t('quota.checkedAt', { time }) : loading ? <Spinner label={t('quota.refresh')} size={14} /> : null}</span>
        <IconButton
          size="sm"
          variant="ghost"
          aria-label={t('quota.refresh')}
          onPress={() => void load()}
          isDisabled={loading}
          data-testid="v3-wb-quota-refresh"
        >
          <RefreshCw size={14} />
        </IconButton>
      </div>
      {error ? (
        <Notice tone="fail" compact data-testid="v3-wb-quota-error">
          {report ? t('quota.stale', { msg: error }) : t('acct.failed', { msg: error })}
        </Notice>
      ) : null}
      {notice ? <Notice compact>{notice}</Notice> : null}

      {cards.map((card) => (
        <QuotaCard key={`${card.source}:${card.key}`} card={card} busy={busyKey === card.key} locked={!!busyKey} onSwitch={() => void switchTo(card)} />
      ))}
      {report && cards.length === 0 ? (
        <EmptyState className="wb-note-block" data-testid="v3-wb-quota-empty" title={t('acct.emptyTitle')} description={t('acct.emptyBody')} />
      ) : null}

      <p className="wb-ctx-note">{text.quotaHint}</p>
      <p className="wb-ctx-note">{text.quotaManage}</p>
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
    cap(card.plan),
    card.source !== 'yan' ? t(sourceKey(card.source)) : '',
    card.alsoIn?.length ? t('acct.alsoIn', { list: card.alsoIn.map((source) => t(sourceKey(source))).join('、') }) : ''
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <Card as="section" className="wb-quota-card" data-testid={`v3-wb-quota-card-${card.source}-${card.provider}`}>
      <div className="wb-quota-id">
        <span className="wb-quota-name" title={[card.label, card.email].filter(Boolean).join(' · ') || undefined}>
          {title}
        </span>
        {card.active ? <Badge tone="accent">{t('acct.active')}</Badge> : null}
        {card.status === 'limited' ? <Badge tone="fail">{t('quota.limitReached')}</Badge> : null}
        {card.switchable && !card.active ? (
          <Button size="sm" variant="secondary" isDisabled={locked} onPress={onSwitch} data-testid="v3-wb-quota-switch">
            {busy ? <Spinner size={12} /> : null}
            {t('acct.switch')}
          </Button>
        ) : null}
      </div>
      {meta ? <div className="wb-quota-meta" title={meta}>{meta}</div> : null}

      {card.status === 'error' ? <Notice tone="fail" compact>{t('acct.failed', { msg: card.error ?? '' })}</Notice> : null}
      {card.status === 'expired' ? <Notice tone="ask" compact>{card.hint}</Notice> : null}

      {stale && (card.windows.length || card.balance) ? (
        <p className="wb-quota-stale" title={t('quota.staleTip')} data-testid="v3-wb-quota-stale">
          {[quotaReadAgo(t, card.checkedAt, now), card.staleError ? t('quota.readFailed', { msg: card.staleError }) : ''].filter(Boolean).join(' · ')}
        </p>
      ) : null}

      {card.windows.map((window) => (
        <QuotaWindowRow key={window.id} window={window} stale={stale} now={now} testId={`v3-wb-quota-win-${window.id}`} />
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
