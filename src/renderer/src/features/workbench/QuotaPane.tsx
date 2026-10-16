/**
 * 工作区「额度」页签（v3）。
 *
 * 显示服务商的账号额度窗口（5 小时 / 周 / 月）与余额，数据来自主进程的
 * `window.yan.accountQuota()` 投影；这不是本机 Token 用量（那在首页用量与输入区
 * 会话统计里）。查询失败时保留上一次的数字并加一行说明，推算值标明来源，
 * 不伪装成官方额度。
 *
 * 只做显示、刷新与切换活跃 ChatGPT 账号（复用 `codexAccountSwitch`）。凭证与
 * 备注、添加 / 移除账号、CLI 来源开关留在设置里，不在这里复制第二套。
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { RefreshCw } from 'lucide-react'
import { useI18n, useT, type MessageKey, type TFunc } from '../../i18n'
import { useStore } from '../../state/store'
import { Badge, Button, IconButton, Meter, Spinner } from '../../ui'
import { quotaTone } from '../../../../shared/quota-tone'
import { money, windowPct } from '../../../../shared/quota-mini'
import {
  accountCardTitle,
  orderAccountCardsForProvider,
  type AccountQuotaCard,
  type AccountQuotaReport,
  type AccountQuotaSource
} from '../../../../shared/account-quota'
import type { QuotaWindow } from '../../../../shared/ipc'
import { workbenchPaneText } from './pane-text'
import type { QuotaPaneProps } from './types'

/** 页签开着时多久自动刷新一次：额度窗口最短 5 小时，再密只会撞服务端限流。 */
const AUTO_REFRESH_MS = 5 * 60_000

const sourceKey = (source: AccountQuotaSource): MessageKey => `acct.source.${source}` as MessageKey
const cap = (value?: string): string => (value ? value.charAt(0).toUpperCase() + value.slice(1) : '')

/** 剩余时长：3天4时 / 2时18分 / 12分（天级不再细到分钟） */
function countdown(t: TFunc, ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const d = Math.floor(total / 86400)
  const h = Math.floor((total % 86400) / 3600)
  const m = Math.floor((total % 3600) / 60)
  if (d > 0) return t('quota.durDH', { d, h })
  if (h > 0) return t('quota.durHM', { h, m })
  return t('quota.durM', { m: Math.max(1, m) })
}

/** 重置时间：月窗口显示日期，其余显示倒计时；已到点显示「待刷新」，不在本地归零。 */
export function resetLine(t: TFunc, window: QuotaWindow): { text: string; tip: string } {
  if (window.resetAt === undefined) return { text: '', tip: '' }
  const now = Date.now()
  const tip = t('quota.resetAtTip', { time: new Date(window.resetAt).toLocaleString(undefined, { hour12: false }) })
  if (window.resetAt <= now) return { text: t('quota.resetDue'), tip }
  if (window.id === 'monthly') {
    const date = new Date(window.resetAt)
    return { text: t('quota.resetOn', { d: `${date.getMonth() + 1}/${date.getDate()}` }), tip }
  }
  return { text: t('quota.resetIn', { t: countdown(t, window.resetAt - now) }), tip }
}

export function QuotaPane(_props: QuotaPaneProps): ReactElement {
  const t = useT()
  const { lang } = useI18n()
  const text = workbenchPaneText(lang)
  /* 当前视图的 provider：把对应账号卡排到最前（主进程不知道当前会话用哪个）。 */
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
    /* 倒计时每 30 秒重算；数据只在可见且过期时重新查 */
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
        <p className="wb-quota-msg" role="alert" data-testid="v3-wb-quota-error">
          {report ? t('quota.stale', { msg: error }) : t('acct.failed', { msg: error })}
        </p>
      ) : null}
      {notice ? <p className="wb-quota-msg" role="status">{notice}</p> : null}

      {cards.map((card) => (
        <QuotaCard key={`${card.source}:${card.key}`} card={card} busy={busyKey === card.key} locked={!!busyKey} onSwitch={() => void switchTo(card)} />
      ))}
      {report && cards.length === 0 ? (
        <div className="wb-note-block" data-testid="v3-wb-quota-empty">
          <p className="wb-note-title">{t('acct.emptyTitle')}</p>
          <p className="wb-note-body">{t('acct.emptyBody')}</p>
        </div>
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
    <section className="wb-quota-card" data-testid={`v3-wb-quota-card-${card.source}-${card.provider}`}>
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

      {card.status === 'error' ? <p className="wb-quota-msg">{t('acct.failed', { msg: card.error ?? '' })}</p> : null}
      {card.status === 'expired' ? <p className="wb-quota-msg">{card.hint}</p> : null}

      {card.windows.map((window) => {
        const pct = windowPct(window, 1) ?? 0
        const tone = window.informational ? 'ok' : quotaTone(pct, window.exceeded)
        const reset = resetLine(t, window)
        return (
          <div key={window.id} className="wb-quota-win" data-tone={tone} data-testid={`v3-wb-quota-win-${window.id}`}>
            <div className="wb-quota-win-top">
              <span className="wb-quota-win-label">{window.label}</span>
              {/* 推算值必须标明来源，不能伪装成官方额度 */}
              {window.estimated ? (
                <span title={t('quota.estimatedTip')}>
                  <Badge>{t('quota.estimated')}</Badge>
                </span>
              ) : null}
              <span className="wb-quota-win-value ui-meta-num">{pct.toFixed(1)}%</span>
            </div>
            <Meter aria-label={window.label} value={Math.min(100, Math.max(0, pct))} minValue={0} maxValue={100} />
            {reset.text ? <div className="wb-quota-win-sub" title={reset.tip}>{reset.text}</div> : null}
          </div>
        )
      })}
      {card.balance ? (
        <div className="wb-quota-win">
          <div className="wb-quota-win-top">
            <span className="wb-quota-win-label">{card.balance.label}</span>
            <span className="wb-quota-win-value ui-meta-num">{money(card.balance.amount, card.balance.currency)}</span>
          </div>
        </div>
      ) : null}
    </section>
  )
}
