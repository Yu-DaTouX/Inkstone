import { useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '../../i18n'
import { Section } from './ToolSection'
import { useStore } from '../../state/store'
import { quotaTone } from '../../../../shared/quota-tone'
import { money, quotaCompactWindows, windowPct } from '../../../../shared/quota-mini'
import { decideQuotaRefresh, hasDueQuotaWindow } from '../../../../shared/quota-refresh'
import { type QuotaWindow } from '../../../../shared/ipc'
import { Button } from '../ui'

/* 一个可折叠的小分区 —— 右栏所有块共用 */

/* 上下文 —— 用多少 / 占多少 / 花了多少 */

export function UsageRing({ percent, tone }: { percent: number | null; tone?: string }) {
  const value = percent === null || !Number.isFinite(percent) ? null : Math.max(0, Math.min(100, percent))
  return (
    <span
      className={`rp-usage-ring ${tone ?? ''}`}
      style={{ '--ring-pct': `${value ?? 0}%` } as React.CSSProperties}
      title={value === null ? '用量未知' : `已用 ${percent!.toFixed(1)}%`}
    >
      <span>{value === null ? '—' : `${Math.round(percent!)}%`}</span>
    </span>
  )
}

/**
 * 额度自动刷新间隔（实施-20 U3）。
 * 官方额度窗口最短是 5 小时，1 分钟粒度足够；再密只会烧服务端限流。
 */
const AUTO_QUOTA_REFRESH_MS = 60_000

export function QuotaSection() {
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
  const mainTone = mainPct === undefined ? '' : quotaTone(mainPct, anyExceeded)
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
  return (
    <Section titleKey="rp.quota" testId="rp-quota" defaultOpen={false} compactWhenFloating extra={
      <span className="rp-header-usage">
        <UsageRing percent={ringPct} tone={ringPct === null ? '' : quotaTone(ringPct, anyExceeded)} />
        <span className="rp-header-values" title={provider || undefined}>
          {compactWindows.length ? compactWindows.map(({ window, label }) => {
            const pct = windowPct(window)
            return <span className={pct === null ? '' : quotaTone(pct, window.exceeded)} key={window.id}>{label} {pct === null ? '—' : `${pct}%`}</span>
          }) : <span>{mainText ?? (loading ? '…' : '—')}</span>}
        </span>
      </span>
    }>
      {/* 标题区：供应商 + 刷新（方案 7.2：刷新放标题区） */}
      <div className="rp-kv">
        <span className="rp-k">{provider || '—'}</span>
        <span className="spacer" />
        <Button size="sm" className="rp-btn" onClick={() => void refresh()} disabled={loading} data-testid="quota-refresh">
          {loading ? '…' : t('quota.refresh')}
        </Button>
      </div>

      {/* 主值：本月已用（有分窗口时）—— 不再取“最紧窗口”的 used */}
      {mainText ? (
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
      {quota ? (
        <div className="rp-dim" data-testid="quota-checked">
          {t('quota.checkedAt', { time: new Date(quota.checkedAt).toLocaleTimeString() })}
        </div>
      ) : null}

      {quota?.windows?.length ? (
        <div className="rp-quota-wins">
          {quota.windows.map((w) => {
            /* 真实比例（可能 > 100%，方案要求如实显示）；与摘要同源 */
            const realPct = windowPct(w, 1) ?? 0
            /* 进度条只夹取宽度，不改数字 */
            const barPct = Math.min(100, Math.max(0, realPct))
            const left = Math.max(0, w.total - w.used)
            /*
             * 颜色分级：<70% 绿 / 70–95% 黄 / ≥95% 红（口径见 shared/quota-tone.ts）。
             * exceeded（供应商报的已超限）恒红，不受百分比影响。
             */
            const tone = quotaTone(realPct, w.exceeded)
            const reset = resetText(w)
            return (
              <div key={w.id} className="rp-quota-win" data-testid={`quota-win-${w.id}`}>
                <div className="rp-kv">
                  <span className="rp-k">{w.label}</span>
                  {/* 推算值必须标明来源，不能伪装成官方额度 */}
                  {w.estimated ? (
                    <span
                      className="rp-quota-est"
                      title={t('quota.estimatedTip')}
                      data-testid={`quota-win-${w.id}-estimated`}
                    >
                      {t('quota.estimated')}
                    </span>
                  ) : null}
                  <span className="spacer" />
                  <span
                    /*
                     * 三档都要落到类名上：以前 ok 档被写成空字符串，于是「低用量」
                     * 用的是 .rp-v 的默认色（--fg-dim 灰）—— 而用户要的是**绿色**。
                     */
                    className={`rp-v ${tone} ${compactWindows.some(({ window }) => window.id === w.id) ? 'rp-mini-duplicate' : ''}`}
                    data-testid={`quota-win-${w.id}-pct`}
                  >
                    {t('quota.usedInline', { pct: realPct.toFixed(1) })}
                  </span>
                </div>
                <div className="rp-kv">
                  <span className="rp-u" data-testid={`quota-win-${w.id}-amount`}>
                    {money(w.used, quota.currency)} / {t('quota.remainingShort')} {money(left, quota.currency)}
                  </span>
                  <span className="spacer" />
                </div>
                <div className={`rp-meter ${tone}`} title={reset || undefined}>
                  <i style={{ width: `${barPct}%` }} />
                </div>
                {w.exceeded ? (
                  <div className="rp-dim err" data-testid={`quota-win-${w.id}-reached`}>
                    {t('quota.limitReached')}
                    {reset ? ` · ${reset}` : ''}
                  </div>
                ) : reset ? (
                  <div className="rp-dim" data-testid={`quota-win-${w.id}-reset`}>
                    {reset}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : null}

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
    </Section>
  )
}

/**
 * 重置说明（方案 7.2）：
 *   · 五小时 / 周 → 本地时区**倒计时**
 *   · 月 → 完整年月日与秒
 *   · 已到点 → 「待刷新」（不本地归零，由 effect 重新查询）
 */
function resetText(w: QuotaWindow): string {
  if (w.resetAt === undefined) return ''
  const now = Date.now()
  if (w.resetAt <= now) return '已到重置时间 · 待刷新'
  if (w.id === 'monthly') {
    return `重置于 ${new Date(w.resetAt).toLocaleString('zh-CN', { hour12: false })}`
  }
  return `重置于 ${countdown(w.resetAt - now)}`
}

/** 剩余时长：3天4时12分后 / 2时18分后 / 12分钟后 */
function countdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const d = Math.floor(total / 86400)
  const h = Math.floor((total % 86400) / 3600)
  const m = Math.floor((total % 3600) / 60)
  if (d > 0) return `${d}天${h}时${m}分后`
  if (h > 0) return `${h}时${m}分后`
  return `${Math.max(1, m)}分钟后`
}
