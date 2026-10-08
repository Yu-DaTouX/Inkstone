import { useCallback, useEffect, useRef, useState } from 'react'
import { useT, type MessageKey } from '../../i18n'
import { quotaTone } from '../../../../shared/quota-tone'
import { money, windowPct } from '../../../../shared/quota-mini'
import {
  ACCOUNT_LABEL_MAX,
  ACCOUNT_QUOTA_CLI_SOURCES,
  accountCardTitle,
  type AccountQuotaCard,
  type AccountQuotaCliSource,
  type AccountQuotaReport,
  type AccountQuotaSource
} from '../../../../shared/account-quota'
import { Badge, Button, Disclosure, EmptyState, IconButton, Input, SettingRow, Spinner, Switch } from '../ui'
import { AgentMark } from '../workbench/AgentMark'
import { resetText } from './QuotaSection'

/** 磁贴开着时多久自动刷新一次：额度窗口最短 5 小时，再密只会撞服务端限流。 */
const AUTO_REFRESH_MS = 5 * 60_000

/** pi 的 provider 名 → AgentMark 的品牌标识；其余服务退回首字母。 */
const MARK: Record<string, string> = { 'openai-codex': 'codex', anthropic: 'claude', gemini: 'gemini' }

const sourceKey = (s: AccountQuotaSource): MessageKey => `acct.source.${s}` as MessageKey
const cap = (s?: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '')

/**
 * 「账号额度」磁贴：砚登录的各个账号（含多个 ChatGPT 账号的切换）与可选的本机 CLI 账号。
 * 数据与凭证都在主进程（account-quota.ts / codex-accounts.ts），这里只显示、改备注、发切换。
 */
export function AccountQuotaPane() {
  const t = useT()
  const [report, setReport] = useState<AccountQuotaReport | null>(null)
  const [loading, setLoading] = useState(false)
  /** 查询失败时保留上一次的数字，只加一行说明 */
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [loggingIn, setLoggingIn] = useState(false)
  const checkedAt = useRef(0)
  const [, setTick] = useState(0)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const next = await window.yan.accountQuota()
      setReport(next)
      setError('')
      checkedAt.current = next.checkedAt
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    /* 倒计时每 30 秒重算；数据只在可见且过期时重新查 */
    const tick = setInterval(() => setTick((v) => v + 1), 30_000)
    const poll = setInterval(() => {
      if (document.visibilityState === 'visible' && Date.now() - checkedAt.current >= AUTO_REFRESH_MS) void load()
    }, 60_000)
    const onFocus = (): void => {
      if (Date.now() - checkedAt.current >= AUTO_REFRESH_MS) void load()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(tick)
      clearInterval(poll)
      window.removeEventListener('focus', onFocus)
    }
  }, [load])

  const switchTo = async (card: AccountQuotaCard): Promise<void> => {
    setBusyKey(card.key)
    setNotice('')
    try {
      const r = await window.yan.codexAccountSwitch(card.key)
      setNotice(r.ok ? t('acct.switched', { name: accountCardTitle(card) }) : t('acct.failed', { msg: r.error ?? '' }))
      if (r.ok) await load()
    } finally {
      setBusyKey(null)
    }
  }

  const remove = async (card: AccountQuotaCard): Promise<void> => {
    if (!window.confirm(t('acct.removeConfirm', { name: accountCardTitle(card) }))) return
    setBusyKey(card.key)
    try {
      const r = await window.yan.codexAccountRemove(card.key)
      if (!r.ok) setNotice(t('acct.failed', { msg: r.error ?? '' }))
      await load()
    } finally {
      setBusyKey(null)
    }
  }

  const saveLabel = async (key: string, label: string): Promise<void> => {
    const prefs = await window.yan.accountLabel(key, label)
    setReport((cur) => cur && { ...cur, prefs, cards: cur.cards.map((c) => (c.key === key ? { ...c, label: prefs.labels[key] } : c)) })
  }

  const addAccount = async (): Promise<void> => {
    setLoggingIn(true)
    setNotice('')
    try {
      const r = await window.yan.codexLogin()
      setNotice(r.ok ? t('acct.added') : r.error ?? '')
      if (r.ok) await load()
    } finally {
      setLoggingIn(false)
    }
  }

  const toggleSource = async (source: AccountQuotaCliSource, enabled: boolean): Promise<void> => {
    const prefs = await window.yan.accountQuotaSource(source, enabled)
    setReport((cur) => cur && { ...cur, prefs })
    await load()
  }

  const cards = report?.cards ?? []
  const time = report ? new Date(report.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : ''

  return (
    <div className="tile-sections acct-pane" data-testid="accounts-pane">
      <div className="acct-head">
        <span>{report ? t('quota.checkedAt', { time }) : loading ? <Spinner mute /> : null}</span>
        <IconButton size="sm" icon="refresh" label={t('quota.refresh')} onClick={() => void load()} disabled={loading} data-testid="acct-refresh" />
      </div>
      {error ? <div className="acct-msg">{report ? t('quota.stale', { msg: error }) : t('acct.failed', { msg: error })}</div> : null}
      {notice ? <div className="acct-msg" role="status">{notice}</div> : null}

      {cards.length ? (
        cards.map((card) => (
          <AccountCard
            key={card.key}
            card={card}
            busy={busyKey === card.key}
            locked={!!busyKey || loggingIn}
            onSwitch={() => void switchTo(card)}
            onRemove={() => void remove(card)}
            onLabel={(label) => saveLabel(card.key, label)}
          />
        ))
      ) : report ? (
        <EmptyState icon="dashboard" title={t('acct.emptyTitle')}>{t('acct.emptyBody')}</EmptyState>
      ) : null}

      <div className="acct-add">
        {loggingIn ? (
          <>
            <Spinner mute />
            <span>{t('auth.loginWaiting')}</span>
            <Button size="sm" variant="ghost" onClick={() => void window.yan.codexLoginCancel()}>{t('ui.cancel')}</Button>
          </>
        ) : (
          <Button size="sm" icon="plus" disabled={!!busyKey} onClick={() => void addAccount()} data-testid="acct-add">{t('acct.add')}</Button>
        )}
      </div>

      <Disclosure title={t('acct.cliSources')} testId="acct-cli-sources">
        <div className="ui-rows">
          <div className="acct-hint">{t('acct.cliHint')}</div>
          {ACCOUNT_QUOTA_CLI_SOURCES.map((source) => (
            <SettingRow key={source} name={t(sourceKey(source))}>
              <Switch
                checked={!!report?.prefs.sources[source]}
                label={t(sourceKey(source))}
                disabled={!report}
                onChange={(next) => void toggleSource(source, next)}
                testId={`acct-source-${source}`}
              />
            </SettingRow>
          ))}
        </div>
      </Disclosure>
    </div>
  )
}

function AccountCard({
  card,
  busy,
  locked,
  onSwitch,
  onRemove,
  onLabel
}: {
  card: AccountQuotaCard
  busy: boolean
  locked: boolean
  onSwitch(): void
  onRemove(): void
  onLabel(label: string): Promise<void>
}) {
  const t = useT()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const title = accountCardTitle(card)
  const meta = [
    title !== card.email ? card.email : '',
    cap(card.plan),
    card.source !== 'yan' ? t(sourceKey(card.source)) : '',
    card.alsoIn?.length ? t('acct.alsoIn', { list: card.alsoIn.map((s) => t(sourceKey(s))).join('、') }) : ''
  ].filter(Boolean).join(' · ')

  const submit = async (): Promise<void> => {
    await onLabel(draft)
    setEditing(false)
  }

  return (
    <section className="acct-card" data-testid={`acct-card-${card.source}-${card.provider}`}>
      {/* 名字一行与暗色的邮箱 · 套餐 · 来源一行靠得更近，与下面的窗口分开 */}
      <div className="acct-card-id">
        <div className="acct-card-head">
          <AgentMark agent={MARK[card.provider] ?? card.provider} size={14} />
          <span className="acct-name" title={[card.label, card.email].filter(Boolean).join(' · ') || undefined}>{title}</span>
          {card.active ? <Badge tone="accent">{t('acct.active')}</Badge> : null}
          {card.status === 'limited' ? <Badge tone="err">{t('quota.limitReached')}</Badge> : null}
          <span className="spacer" />
          {card.switchable && !card.active ? (
            <Button size="sm" title={t('acct.switchTip')} disabled={locked} onClick={onSwitch} data-testid="acct-switch">
              {busy ? <Spinner mute /> : null}
              <span>{t('acct.switch')}</span>
            </Button>
          ) : null}
          <IconButton
            size="sm"
            icon="pencil"
            label={t('acct.editLabel')}
            disabled={locked}
            onClick={() => {
              setDraft(card.label ?? '')
              setEditing((v) => !v)
            }}
            data-testid="acct-edit"
          />
        </div>
        {meta ? <div className="acct-meta" title={meta}>{meta}</div> : null}
      </div>

      {editing ? (
        <form
          className="acct-edit"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <Input
            autoFocus
            value={draft}
            maxLength={ACCOUNT_LABEL_MAX}
            placeholder={t('acct.labelPlaceholder')}
            aria-label={t('acct.editLabel')}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation()
                setEditing(false)
              }
            }}
            data-testid="acct-label-input"
          />
          <Button size="sm" variant="primary" type="submit">{t('auth.save')}</Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>{t('ui.cancel')}</Button>
          {card.switchable ? (
            <Button size="sm" variant="danger" disabled={locked} onClick={onRemove} data-testid="acct-remove">{t('acct.remove')}</Button>
          ) : null}
        </form>
      ) : null}

      {card.status === 'error' ? <div className="acct-msg">{t('acct.failed', { msg: card.error ?? '' })}</div> : null}
      {card.status === 'expired' ? <div className="acct-msg">{card.hint}</div> : null}

      {card.windows.map((w) => {
        const pct = windowPct(w, 1) ?? 0
        const tone = quotaTone(pct, w.exceeded)
        const reset = resetText(t, w)
        return (
          <div key={w.id} className="quota-block" data-testid={`acct-win-${w.id}`}>
            <div className="quota-block-top">
              <span className="quota-block-label">{w.label}</span>
              <span className={`quota-block-value ${tone.replace('ok', '')}`}>{pct.toFixed(1)}<small>%</small></span>
            </div>
            <div className={`ui-quota-track ${tone}`}><i style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} /></div>
            {reset.text ? <div className="quota-block-sub"><span title={reset.tip}>{reset.text}</span></div> : null}
          </div>
        )
      })}
      {card.balance ? (
        <div className="quota-block">
          <div className="quota-block-top">
            <span className="quota-block-label">{card.balance.label}</span>
            <span className="quota-block-value">{money(card.balance.amount, card.balance.currency)}</span>
          </div>
        </div>
      ) : null}
    </section>
  )
}
