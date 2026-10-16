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

/**
 * 额度自动刷新间隔（实施-20 U3）。
 * 官方额度窗口最短是 5 小时，1 分钟粒度足够；再密只会烧服务端限流。
 */
const AUTO_QUOTA_REFRESH_MS = 60_000

type QuotaWindowKind = 'fiveHour' | 'weekly' | 'monthly'

const WINDOW_NAME_KEY = {
  fiveHour: 'quota.win.fiveHour',
  weekly: 'quota.win.weekly',
  monthly: 'quota.win.monthly'
} as const

/**
 * 窗口种类：先按 id 认，id 对不上再按标签字样认（供应商返回的标签可能是中文或英文）。
 * 认不出来的窗口保留供应商给的标签原文。
 */
function quotaWindowKind(w: QuotaWindow): QuotaWindowKind | null {
  if (w.id === 'fiveHour' || w.id === 'primary' || /小时|\bhours?\b|\b\d+\s*h\b/i.test(w.label)) return 'fiveHour'
  if (w.id === 'weekly' || w.id === 'secondary' || /每周|本周|weekly|\bweek\b/i.test(w.label)) return 'weekly'
  if (w.id === 'monthly' || /本月|月度|monthly|\bmonth\b/i.test(w.label)) return 'monthly'
  return null
}

/** 窗口的展示名（随界面语言）：5 小时 / 每周 / 本月；认不出时用供应商的标签 */
function windowName(t: TFunc, w: QuotaWindow): string {
  const kind = quotaWindowKind(w)
  return kind ? t(WINDOW_NAME_KEY[kind]) : w.label
}

/** 紧凑栏的短名：5h / 周 / 月（周、月随语言） */
function compactWindowName(t: TFunc, w: QuotaWindow, fallback: string): string {
  switch (quotaWindowKind(w)) {
    case 'fiveHour': return '5h'
    case 'weekly': return t('quota.win.weekShort')
    case 'monthly': return t('quota.win.monthShort')
    default: return fallback
  }
}

/** 主值的标签：供应商的「余额」标签随语言显示 */
function mainValueLabel(t: TFunc, label: string): string {
  return /余额|balance/i.test(label) ? t('quota.balance') : label
}

/** `status`: the status-bar entry, a summary that opens the same details above it. */
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
  /** 后端确认该 provider 支不支持额度接口（supported === true/false）；null = 还没查过 */
  const [supported, setSupported] = useState<boolean | null>(null)
  /** 只认属于当前 provider 的已加载快照：切供应商时不能让上一个的旧数字留在屏幕上 */
  const quota = quotaSnapshotMatchesProvider(quotaState?.provider, provider) ? quotaState : null
  /** 查询失败时的错误；**不**清掉 quota —— 保留上一次成功的快照（方案 7.2） */
  const [error, setError] = useState('')
  /** 当前请求属于哪个 provider：切账户后旧请求的返回不能覆盖新视图 */
  const providerRef = useRef(provider)
  /* 渲染当帧就认领当前 provider，不等重置 effect —— 切 provider 的过渡帧里旧结果也要作废。 */
  providerRef.current = provider
  /** 倒计时刷新用（重置时间要以“现在”为基准） */
  const [, setTick] = useState(0)
  /** 正在飞的那笔查询属于哪个 provider（同 provider 不重叠；切了就允许新请求） */
  const inFlightRef = useRef<string | null>(null)
  /**
   * 并发请求代次：每笔查询自增，只有代次仍是最新的一笔才能落地。
   * 不能只看 provider 字符串 —— A→B→A 时旧 A 请求和新 A 请求的 provider 相同，
   * 旧结果会把新结果覆盖、还会把新请求的 loading 清掉。
   */
  const requestGenRef = useRef(0)
  /** 同一 provider 已有请求在飞时记下「还欠一次刷新」，等它回来立刻补，不丢最后一次。 */
  const pendingRefreshRef = useRef<string | null>(null)
  /** 指向最新的 refresh：补齐欠下的刷新时用新闭包（新 budget），不用旧闭包。 */
  const refreshRef = useRef<() => Promise<void>>(async () => {})
  /** 上次成功快照的时间戳：窗口重新获得焦点时用它判断是否该补查 */
  const checkedAtRef = useRef<number | null>(null)
  /** 该 provider 是否支持额度接口；false 时不做任何自动查询（自定义 API） */
  const supportedRef = useRef<boolean | null>(null)
  /** 相同窗口的过期响应不能驱动下一笔即时查询。 */
  const resetAttemptsRef = useRef(new Set<string>())
  /* 长任务开关：都只作用于当前会话 */
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
    /* 同一 provider 已有请求在飞：不并发，但记住还要再刷一次，别把最后一次请求丢掉。 */
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
      /* 已经有更新的一笔请求，或用户已经切到别的 provider：这笔整个作废。 */
      if (gen !== requestGenRef.current || providerRef.current !== provider) return
      const hasData =
        !!next.windows?.length || next.remaining !== undefined || next.used !== undefined
      if (next.error && !hasData) {
        setError(next.error)
      } else {
        setQuota(next)
        /* 主进程退回了上次成功的数据：显示旧数字并说明本次失败的原因 */
        setError(next.staleError ?? next.error ?? '')
        checkedAtRef.current = Date.now()
      }
      supportedRef.current = next.supported ?? true
      setSupported(next.supported ?? true)
    } catch (e) {
      /* Promise 直接 reject 时 supported 还没回来；错误仍要落地并被渲染看见。 */
      if (gen === requestGenRef.current && providerRef.current === provider) {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      /* 只有「仍是自己这一笔」才清 in-flight 与 loading，旧请求不得清掉新请求的 loading。 */
      if (inFlightRef.current === provider && gen === requestGenRef.current && providerRef.current === provider) {
        inFlightRef.current = null
        setLoading(false)
      }
      const pending = pendingRefreshRef.current
      pendingRefreshRef.current = null
      /* 完成的是当前 provider 且没有更新的一笔在飞：立刻补跑欠下的那次刷新。 */
      if (pending === provider && pending === providerRef.current && gen === requestGenRef.current) {
        void refreshRef.current()
      }
    }
  }, [provider, budget])
  /* 每次渲染都指向最新的 refresh，供 finally 里的补跑使用（不放进 deps，避免额外触发）。 */
  refreshRef.current = refresh

  /* 切 provider 时清空旧账户的数字（不能把上一个账户的额度留在屏幕上） */
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

  /* 倒计时每分钟重算；到点后自动重新查询（不本地归零） */
  useEffect(() => {
    const id = setInterval(() => setTick((v) => v + 1), 30_000)
    return () => clearInterval(id)
  }, [])
  /*
   * 周期刷新（实施-20 U3）：只在页面可见、该 provider 真的支持额度接口、
   * 且没有请求在飞时执行。不支持的 provider 一次都不自动查，避免无意义报错。
   */
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
  /*
   * 窗口重新获得焦点：快照比周期还旧才补查（频繁切窗口不重复打扰接口）。
   */
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
  /**
   * 百分比口径（ChatGPT 订阅的用量接口只给 used_percent）。
   * 用 PERCENT 这个伪币种传递 —— 它不能走 money()，否则会显示成 “$28.00”。
   */
  const isPercent = (quota?.currency ?? '').toUpperCase() === 'PERCENT'
  /**
   * 主值口径（方案 7.2）：
   *   · 有分窗口（commandcode / codex）→ **本月已用**（不是最紧窗口的已用）
   *   · 其它供应商（deepseek 余额 / openrouter 信用）→ 沿用原有语义
   */
  const hasWindows = !!quota?.windows?.length
  const anyExceeded = !!quota?.windows?.some((w) => w.exceeded)
  /*
   * 主值着色沿用窗口那一套阈值（quotaTone：<70% 绿 / 70–95% 黄 / ≥95% 红）。
   * 以前主值只在「已超限」时变红 —— 结果 95% 的窗口红着、主值还是黑的，
   * 看着像「还没到线」，与窗口自相矛盾。
   * 没有 used/total 的口径（例如 DeepSeek 的余额）拿不到使用率，就不着色。
   */
  const mainPct =
    quota?.used !== undefined && quota.total !== undefined && quota.total > 0
      ? (quota.used / quota.total) * 100
      : undefined
  /* 正常档不着色（用前景色），只在黄 / 红档提醒 —— 绿色留给「完成」一类语义 */
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
  /* 摘要条跟最紧的那个窗口；任一窗口已超限时条也标红 */
  const ringTone = ringPct === null ? '' : quotaTone(ringPct, anyExceeded)
  /*
   * 空入口不渲染；但「已知支持额度接口的 provider 查询失败 / 未返回窗口」必须
   * 留下——否则整段消失，用户分不清是没额度还是查询出错（见 shared/quota-display.ts）。
   * 明确不支持的 provider（supported === false，例如自定义 API）仍不占位。
   */
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
      {/* 主值：本月已用（有分窗口时）—— 不再取“最紧窗口”的 used */}
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
      {/* 查询失败时保留旧快照，但必须说清它是什么时候的（方案 7.2） */}
      {error && !quota?.error ? (
        <div className="rp-dim" data-testid="quota-error">
          {quota ? t('quota.stale', { msg: error }) : t('acct.failed', { msg: error })}
        </div>
      ) : null}


      {quota?.windows?.length ? (
        <div className="rp-quota-wins">
          {quota.windows.map((w) => {
            /* 真实比例（可能 > 100%，方案要求如实显示）；与摘要同源 */
            const realPct = windowPct(w, 1) ?? 0
            /* 进度条只夹取宽度，不改数字 */
            const barPct = Math.min(100, Math.max(0, realPct))
            /*
             * 颜色分级：<70% 正常 / 70–95% 黄 / ≥95% 红（口径见 shared/quota-tone.ts）。
             * exceeded（供应商报的已超限）恒红，不受百分比影响。
             * 正常档：数字用前景色、条用强调色；绿色留给「完成」一类语义。
             */
            const tone = quotaTone(realPct, w.exceeded)
            const reset = resetText(t, w)
            /* 百分比口径（codex）的 used/total 就是百分比本身，再写一遍金额只是重复 */
            const amount = isPercent ? '' : `${money(w.used, quota.currency)} / ${money(w.total, quota.currency)}`
            return (
              /* 一个窗口两行：标签 | 条 | 百分比；下面一行暗色的「已用 / 总额  重置」对齐到条，窄栏时整段换行 */
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
                    {/* 推算值必须标明来源，不能伪装成官方额度；徽标不参与省略 */}
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

      {/* 来源与时间：一行暗色信息，刷新是行尾的图标按钮 */}
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

      {/* Monthly budget is only available for metered OpenAI API keys. */}
      {budgetControl}
    </>
  )
  /* Status-bar popover: one block per window, a large percentage and a quiet sub line. */
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
      {/* 没有成功过的快照时只说失败，不能声称下面还有旧数据 */}
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
      {/* 没有时间、没在加载、也没有预算控件时整行不占位，否则浮层底部留一块空白 */}
      {quota || loading || budgetControl ? (
        <div className="quota-pop-foot">
          {quota ? <span data-testid="quota-checked" title={new Date(quota.checkedAt).toLocaleString()}>{t('quota.checkedAt', { time: new Date(quota.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) })}</span> : <span>{loading ? '…' : ''}</span>}
          {budgetControl}
        </div>
      ) : null}
    </div>
  )
  /* 状态栏只有一句摘要：没拿到数据时把失败原因挂在悬停提示上，别让「—」无从解释 */
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

/**
 * 重置说明（方案 7.2）：行内写短的，完整时间放悬停提示。
 *   · 五小时 / 周 → 倒计时「57分后重置」「6天5时后重置」
 *   · 月 → 日期「10/22 重置」
 *   · 已到点 → 「待刷新」（不本地归零，由 effect 重新查询）
 */
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
