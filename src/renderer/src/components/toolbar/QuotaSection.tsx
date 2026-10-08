import { useCallback, useEffect, useRef, useState } from 'react'
import { useT, type TFunc } from '../../i18n'
import { Section } from './ToolSection'
import { useStore } from '../../state/store'
import { quotaTone } from '../../../../shared/quota-tone'
import { money, quotaCompactWindows, windowPct } from '../../../../shared/quota-mini'
import { decideQuotaRefresh, hasDueQuotaWindow } from '../../../../shared/quota-refresh'
import { type QuotaWindow } from '../../../../shared/ipc'
import { Button, IconButton, MiniMeter } from '../ui'
import { DetailTrigger } from '../shell/DetailPopover'

/**
 * 额度自动刷新间隔（实施-20 U3）。
 * 官方额度窗口最短是 5 小时，1 分钟粒度足够；再密只会烧服务端限流。
 */
const AUTO_QUOTA_REFRESH_MS = 60_000

/** `status`: the status-bar entry, a summary that opens the same details above it. */
export function QuotaSection({ variant = 'section' }: { variant?: 'section' | 'status' } = {}) {
  const t = useT()
  const provider = useStore((s) => s.session?.model?.provider ?? '')
  const settings = useStore((s) => s.settings)
  const patchSettings = useStore((s) => s.patchSettings)
  const budget = settings?.providerBudgets?.[provider]
  const [quota, setQuota] = useState<Awaited<ReturnType<typeof window.yan.providerQuota>> | null>(null)
  const [loading, setLoading] = useState(false)
  /** 查询失败时的错误；**不**清掉 quota —— 保留上一次成功的快照（方案 7.2） */
  const [error, setError] = useState('')
  /** 当前请求属于哪个 provider：切账户后旧请求的返回不能覆盖新视图 */
  const providerRef = useRef(provider)
  /** 倒计时刷新用（重置时间要以“现在”为基准） */
  const [, setTick] = useState(0)
  /** 正在飞的那笔查询属于哪个 provider（同 provider 不重叠；切了就允许新请求） */
  const inFlightRef = useRef<string | null>(null)
  /** 上次成功快照的时间戳：窗口重新获得焦点时用它判断是否该补查 */
  const checkedAtRef = useRef<number | null>(null)
  /** 该 provider 是否支持额度接口；false 时不做任何自动查询（自定义 API） */
  const supportedRef = useRef<boolean | null>(null)

  const refresh = useCallback(async () => {
    if (!provider) return
    if (inFlightRef.current === provider) return
    inFlightRef.current = provider
    providerRef.current = provider
    setLoading(true)
    try {
      const next = await window.yan.providerQuota(provider, budget)
      /* 用户已经切到别的供应商了 —— 这个结果作废 */
      if (providerRef.current !== provider) return
      const hasData =
        !!next.windows?.length || next.remaining !== undefined || next.used !== undefined
      if (next.error && !hasData) {
        setError(next.error)
      } else {
        setQuota(next)
        setError(next.error ?? '')
        checkedAtRef.current = Date.now()
      }
      supportedRef.current = next.supported ?? true
    } catch (e) {
      if (providerRef.current === provider) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (inFlightRef.current === provider) inFlightRef.current = null
      if (providerRef.current === provider) setLoading(false)
    }
  }, [provider, budget])

  /* 切 provider 时清空旧账户的数字（不能把上一个账户的额度留在屏幕上） */
  useEffect(() => {
    providerRef.current = provider
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
    if (hasDueQuotaWindow(wins, Date.now())) void refresh()
  }, [quota, refresh])
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
  const mainLabel = quota?.label ?? (hasWindows ? t('quota.usedMain') : t('quota.remaining'))
  const compactWindows = quotaCompactWindows(quota?.windows ?? [])
  const ringWindow = compactWindows.reduce<QuotaWindow | null>((highest, item) =>
    !highest || item.window.used / item.window.total > highest.used / highest.total ? item.window : highest, null)
  const ringPct = ringWindow && ringWindow.total > 0 ? ringWindow.used / ringWindow.total * 100 : (mainPct ?? null)
  /* 摘要条跟最紧的那个窗口；任一窗口已超限时条也标红 */
  const ringTone = ringPct === null ? '' : quotaTone(ringPct, anyExceeded)
  /* 空入口不渲染：没有供应商，或查不到任何可显示的数（不支持 / 未登录 / 出错）时整块不占位 */
  if (!provider || (!loading && !mainText && compactWindows.length === 0 && !budget)) return null

  const summary = (
      <span className="rp-header-usage">
        <span className="rp-header-values" title={provider || undefined}>
          {compactWindows.length ? compactWindows.map(({ window, label }) => {
            const pct = windowPct(window)
            return (
              <span className={pct === null ? '' : quotaTone(pct, window.exceeded)} key={window.id}>
                <span className="rp-header-k">{label}</span> <b>{pct === null ? '—' : `${pct}%`}</b>
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
          {t('quota.stale', { msg: error })}
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
                <span className="rp-quota-label">{w.label}</span>
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

      <div className="rp-quota-actions">
        {/* 月预算只适用于按量计费的 openai 平台 key；订阅制（codex）没有这个概念 */}
        {provider === 'openai' ? (
          <Button size="sm" className="rp-btn" onClick={() => {
              const value = window.prompt(t('quota.budgetPrompt'), budget ? String(budget) : '')
              if (value === null) return
              const n = Number(value)
              if (!Number.isFinite(n) || n <= 0) return
              void patchSettings({
                providerBudgets: { ...(settings?.providerBudgets ?? {}), [provider]: n }
              })
            }}>
            {t('quota.setBudget')}
          </Button>
        ) : null}
      </div>
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
      {error && !quota?.error ? <div className="rp-dim" data-testid="quota-error">{t('quota.stale', { msg: error })}</div> : null}
      {quota?.windows?.map((w) => {
        const realPct = windowPct(w, 1) ?? 0
        const tone = quotaTone(realPct, w.exceeded)
        const reset = resetText(t, w)
        const amount = isPercent ? '' : `${money(w.used, quota.currency)} / ${money(w.total, quota.currency)}`
        return (
          <div key={w.id} className="quota-block" data-testid={`quota-win-${w.id}`}>
            <div className="quota-block-top">
              <span className="quota-block-label">{w.label}</span>
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
      <div className="quota-pop-foot">
        {quota ? <span data-testid="quota-checked" title={new Date(quota.checkedAt).toLocaleString()}>{t('quota.checkedAt', { time: new Date(quota.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) })}</span> : <span>{loading ? '…' : ''}</span>}
        {provider === 'openai' ? <Button size="sm" variant="ghost" onClick={() => {
          const value = window.prompt(t('quota.budgetPrompt'), budget ? String(budget) : '')
          if (value === null) return
          const n = Number(value)
          if (!Number.isFinite(n) || n <= 0) return
          void patchSettings({ providerBudgets: { ...(settings?.providerBudgets ?? {}), [provider]: n } })
        }}>{t('quota.setBudget')}</Button> : null}
      </div>
    </div>
  )
  if (variant === 'status') return (
    <DetailTrigger className="sb-seg sb-quota" testId="sb-quota" label={t('rp.quota')} title={provider || undefined} panel={popover}>
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
