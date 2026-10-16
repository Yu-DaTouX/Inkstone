import { useCallback, useEffect, useRef, useState } from 'react'
import { useT, type TFunc } from '../../i18n'
import { Section } from './ToolSection'
import { useStore } from '../../state/store'
import { quotaTone } from '../../../../shared/quota-tone'
import { money, quotaCompactWindows, windowPct } from '../../../../shared/quota-mini'
import { claimDueQuotaWindows, decideQuotaRefresh } from '../../../../shared/quota-refresh'
import { quotaSnapshotMatchesProvider, shouldRenderQuotaSection } from '../../../../shared/quota-display'
import { type QuotaWindow } from '../../../../shared/ipc'
import { Button, IconButton, Input, MiniMeter, Switch } from '../ui'
import { DetailTrigger } from '../shell/DetailPopover'
import { selectFiniteQuotaWindow } from './workspace-control-guards'

const AUTO_QUOTA_REFRESH_MS = 60_000

type QuotaWindowKind = 'fiveHour' | 'weekly' | 'monthly'

const WINDOW_NAME_KEY = {
  fiveHour: 'quota.win.fiveHour',
  weekly: 'quota.win.weekly',
  monthly: 'quota.win.monthly'
} as const

function quotaWindowKind(w: QuotaWindow): QuotaWindowKind | null {
  if (w.id === 'fiveHour' || w.id === 'primary' || /小时|\bhours?\b|\b\d+\s*h\b/i.test(w.label)) return 'fiveHour'
  if (w.id === 'weekly' || w.id === 'secondary' || /每周|本周|weekly|\bweek\b/i.test(w.label)) return 'weekly'
  if (w.id === 'monthly' || /本月|月度|monthly|\bmonth\b/i.test(w.label)) return 'monthly'
  return null
}

function windowName(t: TFunc, w: QuotaWindow): string {
  const kind = quotaWindowKind(w)
  return kind ? t(WINDOW_NAME_KEY[kind]) : w.label
}

function compactWindowName(t: TFunc, w: QuotaWindow, fallback: string): string {
  switch (quotaWindowKind(w)) {
    case 'fiveHour': return '5h'
    case 'weekly': return t('quota.win.weekShort')
    case 'monthly': return t('quota.win.monthShort')
    default: return fallback
  }
}

function mainValueLabel(t: TFunc, label: string): string {
  return /余额|balance/i.test(label) ? t('quota.balance') : label
}

export function QuotaSection({ variant = 'section' }: { variant?: 'section' | 'status' } = {}) {
  const t = useT()
  const provider = useStore((s) => s.session?.model?.provider ?? '')
  const settings = useStore((s) => s.settings)
  const patchSettings = useStore((s) => s.patchSettings)
  const budget = settings?.providerBudgets?.[provider]
  const [budgetEditing, setBudgetEditing] = useState(false)
  const [budgetDraft, setBudgetDraft] = useState('')
  const [budgetError, setBudgetError] = useState('')
  const [quotaState, setQuota] = useState<Awaited<ReturnType<typeof window.yan.providerQuota>> | null>(null)
  const [loading, setLoading] = useState(false)
  const [supported, setSupported] = useState<boolean | null>(null)
  const quota = quotaSnapshotMatchesProvider(quotaState?.provider, provider) ? quotaState : null
  const [error, setError] = useState('')
  const providerRef = useRef(provider)
  providerRef.current = provider
  const [, setTick] = useState(0)
  const inFlightRef = useRef<string | null>(null)
  const requestGenRef = useRef(0)
  const pendingRefreshRef = useRef<string | null>(null)
  const refreshRef = useRef<() => Promise<void>>(async () => {})
  const checkedAtRef = useRef<number | null>(null)
  const supportedRef = useRef<boolean | null>(null)
  const resetAttemptsRef = useRef(new Set<string>())
  const sessionId = useStore((s) => s.session?.sessionId)
  const failoverOn = useStore((s) => !!s.session && s.quotaFailover?.sessionId === s.session.sessionId)
  const keepRunning = useStore((s) => (s.session && s.keepRunning?.sessionId === s.session.sessionId ? s.keepRunning : null))
  const setQuotaFailover = useStore((s) => s.setQuotaFailover)
  const setKeepRunning = useStore((s) => s.setKeepRunning)
  const [codexAccounts, setCodexAccounts] = useState(0)
  useEffect(() => {
    if (provider !== 'openai-codex') return
    let live = true
    void window.yan.codexAccounts().then((list) => { if (live) setCodexAccounts(list.length) }).catch(() => undefined)
    return () => { live = false }
  }, [provider])

  const refresh = useCallback(async () => {
    if (!provider) return
    if (inFlightRef.current === provider) {
      pendingRefreshRef.current = provider
      return
    }
    const gen = ++requestGenRef.current
    inFlightRef.current = provider
    providerRef.current = provider
    setLoading(true)
    try {
      const next = await window.yan.providerQuota(provider, budget)
      if (gen !== requestGenRef.current || providerRef.current !== provider) return
      const hasData =
        !!next.windows?.length || next.remaining !== undefined || next.used !== undefined
      if (next.error && !hasData) {
        setError(next.error)
      } else {
        setQuota(next)
        setError(next.staleError ?? next.error ?? '')
        checkedAtRef.current = Date.now()
      }
      supportedRef.current = next.supported ?? true
      setSupported(next.supported ?? true)
    } catch (e) {
      if (gen === requestGenRef.current && providerRef.current === provider) {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      if (inFlightRef.current === provider && gen === requestGenRef.current && providerRef.current === provider) {
        inFlightRef.current = null
        setLoading(false)
      }
      const pending = pendingRefreshRef.current
      pendingRefreshRef.current = null
      if (pending === provider && pending === providerRef.current && gen === requestGenRef.current) {
        void refreshRef.current()
      }
    }
  }, [provider, budget])
  refreshRef.current = refresh

  useEffect(() => {
    providerRef.current = provider
    resetAttemptsRef.current.clear()
    checkedAtRef.current = null
    supportedRef.current = null
    setSupported(null)
    setQuota(null)
    setError('')
    void refresh()
  }, [refresh, provider])

  useEffect(() => {
    const id = setInterval(() => setTick((v) => v + 1), 30_000)
    return () => clearInterval(id)
  }, [])
  useEffect(() => {
    if (!provider) return
    const id = window.setInterval(() => {
      const decision = decideQuotaRefresh({
        trigger: 'periodic',
        now: Date.now(),
        lastCheckedAt: checkedAtRef.current,
        intervalMs: AUTO_QUOTA_REFRESH_MS,
        visible: document.visibilityState === 'visible',
        supported: supportedRef.current,
        provider,
        inFlightProvider: inFlightRef.current
      })
      if (decision.query) void refresh()
    }, AUTO_QUOTA_REFRESH_MS)
    return () => window.clearInterval(id)
  }, [provider, refresh])
  useEffect(() => {
    const onFocus = () => {
      const decision = decideQuotaRefresh({
        trigger: 'focus',
        now: Date.now(),
        lastCheckedAt: checkedAtRef.current,
        intervalMs: AUTO_QUOTA_REFRESH_MS,
        visible: true,
        supported: supportedRef.current,
        provider,
        inFlightProvider: inFlightRef.current
      })
      if (decision.query) void refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [provider, refresh])
  useEffect(() => {
    const wins = quota?.windows ?? []
    if (!wins.length) return
    const now = Date.now()
    const decision = decideQuotaRefresh({
      trigger: 'reset', now, lastCheckedAt: checkedAtRef.current,
      intervalMs: AUTO_QUOTA_REFRESH_MS,
      visible: document.visibilityState === 'visible', supported: supportedRef.current,
      provider, inFlightProvider: inFlightRef.current
    })
    if (decision.query && claimDueQuotaWindows(wins, now, resetAttemptsRef.current)) void refresh()
  }, [quota, provider, refresh])
  const isPercent = (quota?.currency ?? '').toUpperCase() === 'PERCENT'
  const hasWindows = !!quota?.windows?.length
  const anyExceeded = !!quota?.windows?.some((w) => w.exceeded)
  const mainPct =
    quota?.used !== undefined && quota.total !== undefined && quota.total > 0
      ? (quota.used / quota.total) * 100
      : undefined
  const mainTone = mainPct === undefined ? '' : quotaTone(mainPct, anyExceeded).replace('ok', '')
  const mainText = !quota
    ? null
    : hasWindows || isPercent
      ? quota.used !== undefined
        ? money(quota.used, quota.currency)
        : null
      : quota.remaining !== undefined
        ? money(quota.remaining, quota.currency)
        : quota.used !== undefined
          ? money(quota.used, quota.currency)
          : null
  const mainLabel = quota?.label ? mainValueLabel(t, quota.label) : (hasWindows ? t('quota.usedMain') : t('quota.remaining'))
  const compactWindows = quotaCompactWindows(quota?.windows ?? [])
  const ringWindow = selectFiniteQuotaWindow(compactWindows.map((item) => item.window))
  const ringPct = ringWindow ? ringWindow.used / ringWindow.total * 100 : (mainPct !== undefined && Number.isFinite(mainPct) ? mainPct : null)
  const saveBudget = async (): Promise<void> => {
    const amount = Number(budgetDraft)
    if (!Number.isFinite(amount) || amount <= 0) return
    try {
      await patchSettings({ providerBudgets: { ...(settings?.providerBudgets ?? {}), [provider]: amount } })
      setBudgetError('')
      setBudgetEditing(false)
    } catch (cause) {
      setBudgetError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  const budgetControl = provider === 'openai' ? budgetEditing ? (
    <form className="rp-quota-actions" data-testid="quota-budget-editor" onSubmit={(event) => { event.preventDefault(); void saveBudget() }}>
      <Input numeric type="number" min="0.01" step="any" required value={budgetDraft} onChange={(event) => setBudgetDraft(event.target.value)} aria-label={t('quota.budgetPrompt')} data-testid="quota-budget-input" />
      <Button size="sm" type="submit">{t('quota.setBudget')}</Button>
      <Button size="sm" type="button" variant="ghost" onClick={() => { setBudgetEditing(false); setBudgetError('') }}>{t('git.cancel')}</Button>
      {budgetError ? <div role="alert" data-testid="quota-budget-error">{budgetError}</div> : null}
    </form>
  ) : <Button size="sm" className="rp-btn" onClick={() => { setBudgetDraft(budget ? String(budget) : ''); setBudgetEditing(true) }}>{t('quota.setBudget')}</Button> : null
  const ringTone = ringPct === null ? '' : quotaTone(ringPct, anyExceeded)
  if (!shouldRenderQuotaSection({
    provider,
    loading,
    supported,
    hasError: !!error || !!quota?.error,
    hasMainText: !!mainText,
    windowCount: compactWindows.length,
    hasBudget: !!budget
  })) return null

  const summary = (
      <span className="rp-header-usage">
        <span className="rp-header-values" title={provider || undefined}>
          {compactWindows.length ? compactWindows.map(({ window, label }) => {
            const pct = windowPct(window)
            return (
              <span className={pct === null ? '' : quotaTone(pct, window.exceeded)} key={window.id}>
                <span className="rp-header-k">{compactWindowName(t, window, label)}</span> <b>{pct === null ? '—' : `${pct}%`}</b>
              </span>
            )
          }) : <b>{mainText ?? (loading ? '…' : '—')}</b>}
        </span>
        {ringPct !== null ? <MiniMeter percent={ringPct} tone={ringTone} /> : null}
      </span>
  )
  const body = (
    <>
      {mainText && !hasWindows ? (
        <div className={`rp-quota-main ${hasWindows ? '' : 'rp-mini-duplicate'}`} data-testid="quota-main">
          <span className="rp-quota-main-label">{mainLabel}</span>
          <span className={`rp-v big ${mainTone}`} data-testid="quota-main-value">
            {mainText}
          </span>
        </div>
      ) : null}

      {quota?.error ? (
        <div className="rp-dim" data-testid="quota-error">
          {quota.supported ? quota.error : t('quota.unsupported')}
        </div>
      ) : null}
      {error && !quota?.error ? (
        <div className="rp-dim" data-testid="quota-error">
          {quota ? t('quota.stale', { msg: error }) : t('acct.failed', { msg: error })}
        </div>
      ) : null}


      {quota?.windows?.length ? (
        <div className="rp-quota-wins">
          {quota.windows.map((w) => {
            const realPct = windowPct(w, 1) ?? 0
            const barPct = Math.min(100, Math.max(0, realPct))
            const tone = quotaTone(realPct, w.exceeded)
            const reset = resetText(t, w)
            const amount = isPercent ? '' : `${money(w.used, quota.currency)} / ${money(w.total, quota.currency)}`
            return (
              <div key={w.id} className="rp-quota-win" data-testid={`quota-win-${w.id}`}>
                <span className="rp-quota-label">{windowName(t, w)}</span>
                <div className={`rp-meter ${tone}`} title={[amount, reset.tip].filter(Boolean).join(' · ') || undefined}>
                  <i style={{ width: `${barPct}%` }} />
                </div>
                <span className={`rp-quota-pct ${tone}`} data-testid={`quota-win-${w.id}-pct`}>
                  {`${realPct.toFixed(1)}%`}
                </span>
                {amount || reset.text || w.estimated ? (
                  <div className="rp-quota-sub">
                    {amount ? (
                      <span
                        className="rp-quota-amount"
                        data-testid={`quota-win-${w.id}-amount`}
                        title={`${t('quota.remainingShort')} ${money(Math.max(0, w.total - w.used), quota.currency)}`}
                      >
                        {amount}
                      </span>
                    ) : null}
                    {reset.text ? <span data-testid={`quota-win-${w.id}-reset`} title={reset.tip}>{reset.text}</span> : null}
                    {w.estimated ? (
                      <span className="ui-badge" title={t('quota.estimatedTip')} data-testid={`quota-win-${w.id}-estimated`}>
                        {t('quota.estimated')}
                      </span>
                    ) : null}
                  </div>
                ) : null}
                {w.exceeded ? (
                  <div className="rp-quota-sub err" data-testid={`quota-win-${w.id}-reached`}>
                    {t('quota.limitReached')}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : null}

      <div className="rp-quota-meta">
        <span className="rp-quota-provider" title={provider || undefined}>{provider || '—'}</span>
        {quota ? (
          <span data-testid="quota-checked" title={new Date(quota.checkedAt).toLocaleString()}>
            {t('quota.checkedAt', { time: new Date(quota.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) })}
          </span>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          icon="refresh"
          className="rp-quota-refresh"
          title={t('quota.refresh')}
          aria-label={t('quota.refresh')}
          onClick={() => void refresh()}
          disabled={loading}
          data-testid="quota-refresh"
        />
      </div>

      {budgetControl}
    </>
  )
  const popover = (
    <div className="quota-pop" data-testid="quota-popover">
      <div className="quota-pop-head">
        <span className="ui-popover-title">{t('rp.quota')}</span>
        <span className="ui-badge quota-pop-provider" title={provider || undefined}>{provider || '—'}</span>
        <span className="spacer" />
        <IconButton size="sm" icon="refresh" label={t('quota.refresh')} onClick={() => void refresh()} disabled={loading} data-testid="quota-refresh" />
      </div>
      {mainText && !hasWindows ? (
        <div className="quota-block" data-testid="quota-main">
          <div className="quota-block-top">
            <span className="quota-block-label">{mainLabel}</span>
            <span className={`quota-block-value ${mainTone}`} data-testid="quota-main-value">{mainText}</span>
          </div>
        </div>
      ) : null}
      {quota?.error ? <div className="rp-dim" data-testid="quota-error">{quota.supported ? quota.error : t('quota.unsupported')}</div> : null}
      {error && !quota?.error ? <div className="rp-dim" data-testid="quota-error">{quota ? t('quota.stale', { msg: error }) : t('acct.failed', { msg: error })}</div> : null}
      {quota?.windows?.map((w) => {
        const realPct = windowPct(w, 1) ?? 0
        const tone = quotaTone(realPct, w.exceeded)
        const reset = resetText(t, w)
        const amount = isPercent ? '' : `${money(w.used, quota.currency)} / ${money(w.total, quota.currency)}`
        return (
          <div key={w.id} className="quota-block" data-testid={`quota-win-${w.id}`}>
            <div className="quota-block-top">
              <span className="quota-block-label">{windowName(t, w)}</span>
              {w.estimated ? <span className="ui-badge" title={t('quota.estimatedTip')} data-testid={`quota-win-${w.id}-estimated`}>{t('quota.estimated')}</span> : null}
              <span className={`quota-block-value ${tone.replace('ok', '')}`} data-testid={`quota-win-${w.id}-pct`}>{realPct.toFixed(1)}<small>%</small></span>
            </div>
            <div className={`ui-quota-track ${tone}`}><i style={{ width: `${Math.min(100, Math.max(0, realPct))}%` }} /></div>
            <div className="quota-block-sub">
              {amount ? <span data-testid={`quota-win-${w.id}-amount`} title={`${t('quota.remainingShort')} ${money(Math.max(0, w.total - w.used), quota.currency)}`}>{amount}</span> : <span />}
              {w.exceeded ? <span className="err" data-testid={`quota-win-${w.id}-reached`}>{t('quota.limitReached')}</span>
                : reset.text ? <span data-testid={`quota-win-${w.id}-reset`} title={reset.tip}>{reset.text}</span> : null}
            </div>
          </div>
        )
      })}
      {sessionId ? (
        <div className="quota-pop-long" data-testid="quota-long-task">
          <span className="quota-block-sub">{t('quota.long.title')}</span>
          {provider === 'openai-codex' && codexAccounts > 1 ? (
            <div className="quota-pop-switch" title={t('quota.failover.hint')}>
              <span className="quota-block-label">{t('quota.long.failover')}</span>
              <Switch label={t('quota.long.failover')} checked={failoverOn} testId="quota-auto-failover" onChange={setQuotaFailover} />
            </div>
          ) : null}
          <div className="quota-pop-switch" title={t('quota.long.keepHint')}>
            <span className="quota-block-label">{t('quota.long.keep')}</span>
            <Switch label={t('quota.long.keep')} checked={!!keepRunning} testId="quota-keep-running" onChange={setKeepRunning} />
          </div>
          {keepRunning ? <span className="quota-block-sub" data-testid="quota-keep-count">{t('quota.long.count', { n: keepRunning.count })}</span> : null}
        </div>
      ) : null}
      {quota || loading || budgetControl ? (
        <div className="quota-pop-foot">
          {quota ? <span data-testid="quota-checked" title={new Date(quota.checkedAt).toLocaleString()}>{t('quota.checkedAt', { time: new Date(quota.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) })}</span> : <span>{loading ? '…' : ''}</span>}
          {budgetControl}
        </div>
      ) : null}
    </div>
  )
  const statusTitle = error && !quota ? t('acct.failed', { msg: error }) : provider || undefined
  if (variant === 'status') return (
    <DetailTrigger className="sb-seg sb-quota" testId="sb-quota" label={t('rp.quota')} title={statusTitle} panel={popover}>
      {summary}
    </DetailTrigger>
  )
  return (
    <Section titleKey="rp.quota" testId="rp-quota" defaultOpen compactWhenFloating extra={summary}>
      {body}
    </Section>
  )
}

export function resetText(t: TFunc, w: QuotaWindow): { text: string; tip: string } {
  if (w.resetAt === undefined) return { text: '', tip: '' }
  const now = Date.now()
  const tip = t('quota.resetAtTip', { time: new Date(w.resetAt).toLocaleString(undefined, { hour12: false }) })
  if (w.resetAt <= now) return { text: t('quota.resetDue'), tip }
  if (w.id === 'monthly') {
    const d = new Date(w.resetAt)
    return { text: t('quota.resetOn', { d: `${d.getMonth() + 1}/${d.getDate()}` }), tip }
  }
  return { text: t('quota.resetIn', { t: countdown(t, w.resetAt - now) }), tip }
}

function countdown(t: TFunc, ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const d = Math.floor(total / 86400)
  const h = Math.floor((total % 86400) / 3600)
  const m = Math.floor((total % 3600) / 60)
  if (d > 0) return t('quota.durDH', { d, h })
  if (h > 0) return t('quota.durHM', { h, m })
  return t('quota.durM', { m: Math.max(1, m) })
}
