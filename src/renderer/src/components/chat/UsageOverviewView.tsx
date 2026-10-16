import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import type { TFunc } from '../../i18n'
import { HEAT_WEEKS, heatLevels, localDay, type UsageRange } from '../../../../shared/usage-stats'
import type { ModelInfo, UsageStatsResult } from '../../../../shared/ipc'

/**
 * 启动页本机用量的纯展示层：只接收已经取好的 `stats` 与回调，不自己请求、不碰 store/i18n 上下文。
 * 容器 `UsageOverview` 负责取数与状态，本组件负责排版，便于在无 Electron 的渲染测试里直接挂载。
 *
 * 主数字是 Token 合计（含子代理），下面一行安静文字给出「主会话 · 子代理」拆分；
 * 会话 / 消息 / 活跃天数 / 高峰时段仍只计主会话，不虚增。
 */

/** 热力图显示的周数：放得进右栏（23rem）不截断 */
const HEAT_SHOWN = 20

export function compactNumber(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`
  if (n >= 1e4) return `${(n / 1e3).toFixed(0)}K`
  return n.toLocaleString()
}

/**
 * 切换控件的渲染槽。
 *
 * 缺省（不传 `renderToggle`）仍是本文件的文字按钮 `Toggle`，外观由 v2 的
 * `styles/chat.css` 负责；v3 的 `patterns/UsagePattern` 传真实 `Tabs` 原语。
 * 共享展示件不 import 任何 v3 控件或样式，两个外壳各自提供切换控件。
 */
export interface UsageToggleProps {
  /** `tab` 切换「概览 / 模型」，`range` 切换统计范围 */
  kind: 'tab' | 'range'
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string) => void
  label: string
  testId?: string
}
export type UsageToggleRenderer = (props: UsageToggleProps) => ReactNode

/** 安静的文字切换：选中项正文色 + 下划强调线，其余淡色（不用分段控件的底块） */
function Toggle<T extends string>({ value, options, onChange, label, testId }: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (v: T) => void
  label: string
  testId?: string
}) {
  return (
    <div className="start-toggle" role="group" aria-label={label} data-testid={testId}>
      {options.map((o) => (
        <button type="button" key={o.value} aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export type UsageOverviewTab = 'overview' | 'models'

/** 占位用的空统计：从 HEAT_WEEKS 周前的周一到今天，每天 0；用于「取数中 / 无记录」仍保留框架。 */
export function emptyUsageStats(range: UsageRange, now = Date.now()): UsageStatsResult {
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const start = new Date(today)
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7) - (HEAT_WEEKS - 1) * 7)
  const heat: Array<{ date: string; tokens: number }> = []
  for (const d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) heat.push({ date: localDay(d.getTime()), tokens: 0 })
  return {
    range,
    sessions: 0,
    messages: 0,
    tokens: 0,
    tokenBreakdown: { main: 0, subagents: 0 },
    activeDays: 0,
    peakHour: null,
    models: [],
    heat,
    at: now,
    userName: ''
  }
}

export interface UsageOverviewViewProps {
  compact?: boolean
  onOpenDetails?: () => void
  stats: UsageStatsResult | null
  range: UsageRange
  tab: UsageOverviewTab
  /** 模型菜单，用于把 provider/model 显示名还原成用户熟悉的名称 */
  models: ModelInfo[]
  t: TFunc
  onTabChange: (tab: UsageOverviewTab) => void
  onRangeChange: (range: UsageRange) => void
  /** v3 用：注入真实 `Tabs` 原语；缺省保持 v2 文字按钮 */
  renderToggle?: UsageToggleRenderer
  /**
   * v3 用：取数中或本机无记录时仍渲染同一框架（数字为「—」或 0），不整块消失。
   * 缺省 false，保持 v2「没有历史就不显示」的行为。
   */
  keepWhenEmpty?: boolean
  /** 无记录时框架里的一行说明（只在 `keepWhenEmpty` 时使用）。 */
  emptyNote?: string
}

export function UsageOverviewView({
  stats,
  range,
  tab,
  models,
  t,
  onTabChange,
  onRangeChange,
  renderToggle,
  keepWhenEmpty = false,
  emptyNote,
  onOpenDetails,
  compact = false
}: UsageOverviewViewProps) {
  /* provider/model → 菜单里的显示名；找不到就取最后一段 id。同名的补上供应商以区分 */
  const names = useMemo(() => {
    const base = (key: string): string => {
      const slash = key.indexOf('/')
      const provider = key.slice(0, slash)
      const id = key.slice(slash + 1)
      const hit = models.find((m) => m.provider === provider && m.id === id) ?? models.find((m) => m.id === id)
      return hit?.name || id.replace(/^.*\//, '')
    }
    const keys = stats?.models.map((m) => m.key) ?? []
    const out = new Map<string, { name: string; provider: string }>()
    for (const key of keys) {
      const name = base(key)
      const dup = keys.some((k) => k !== key && base(k) === name)
      out.set(key, { name, provider: dup ? key.slice(0, key.indexOf('/')) : '' })
    }
    return out
  }, [stats, models])

  const levels = useMemo(() => heatLevels(stats?.heat.map((d) => d.tokens) ?? []), [stats])
  const [pixelRatio, setPixelRatio] = useState(() => typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1)
  useEffect(() => {
    const update = () => setPixelRatio(window.devicePixelRatio || 1)
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])
  const gridStyle = { '--cell': `${Math.round(10 * pixelRatio) / pixelRatio}px`, gap: `${Math.max(1, Math.round(2 * pixelRatio)) / pixelRatio}px` } as CSSProperties
  /* 主会话为 0 但只有子代理 Token 时仍要显示；会话/消息仍如实是 0 主会话 */
  const noHistory = !!stats && range === 'all' && stats.sessions === 0 && stats.tokens === 0
  if (!keepWhenEmpty && (!stats || noHistory)) return null
  /* 取数中：同一框架，数字显示「—」；无记录：显示 0 并给一行说明 */
  const pending = !stats
  const note = noHistory ? emptyNote : undefined
  const data = stats ?? emptyUsageStats(range)
  const dash = (value: string): string => (pending ? '—' : value)

  /* Token 总数单独做主数字；其余只留一行三项（最常用模型在「模型」页） */
  const tiles: Array<[string, string]> = [
    [t('usage.sessions'), dash(data.sessions.toLocaleString())],
    [t('usage.messages'), dash(compactNumber(data.messages))],
    [t('usage.activeDays'), dash(String(data.activeDays))]
  ]
  /* 热力图只画近 HEAT_SHOWN 周：序列从周一开始，去掉更早的整周即可保持对齐 */
  const skip = Math.max(0, (HEAT_WEEKS - HEAT_SHOWN) * 7)
  const heat = data.heat.slice(skip)
  const total = data.models.reduce((sum, m) => sum + m.tokens, 0)

  return (
    <aside className="start-sec start-usage" data-testid="usage-overview" data-pending={pending ? '' : undefined} aria-busy={pending || undefined} aria-label={t('usage.title')}>
      <div className="start-usage-head">
        <h2 className="start-label">{onOpenDetails ? <button className="start-details-link" type="button" onClick={onOpenDetails}>{t('usage.title')} ↗</button> : t('usage.title')}</h2>
        <span className="start-spacer" />
        {!compact && (renderToggle ? renderToggle({
          kind: 'tab',
          label: t('usage.title'),
          value: tab,
          options: [
            { value: 'overview', label: t('usage.overview') },
            { value: 'models', label: t('usage.models') }
          ],
          onChange: (v) => onTabChange(v as UsageOverviewTab)
        }) : (
          <Toggle
            label={t('usage.title')}
            value={tab}
            onChange={onTabChange}
            options={[
              { value: 'overview', label: t('usage.overview') },
              { value: 'models', label: t('usage.models') }
            ]}
          />
        ))}
      </div>
      {!compact && <div className="start-usage-head">
        {renderToggle ? renderToggle({
          kind: 'range',
          label: t('usage.range'),
          value: range,
          options: [
            { value: 'all', label: t('usage.all') },
            { value: '30d', label: t('usage.days', { n: 30 }) },
            { value: '7d', label: t('usage.days', { n: 7 }) }
          ],
          onChange: (v) => onRangeChange(v as UsageRange),
          testId: 'usage-range'
        }) : (
          <Toggle
            label={t('usage.range')}
            value={range}
            onChange={onRangeChange}
            testId="usage-range"
            options={[
              { value: 'all', label: t('usage.all') },
              { value: '30d', label: t('usage.days', { n: 30 }) },
              { value: '7d', label: t('usage.days', { n: 7 }) }
            ]}
          />
        )}
      </div>}

      {tab === 'overview' ? (
        <>
          <div className="start-hero">
            <span className="start-hero-num" data-testid="usage-tokens" title={t('usage.tokensHint')}>
              {dash(compactNumber(data.tokens))}
            </span>
            <span className="start-label">{t('usage.tokens')}</span>
          </div>
          {note ? <p className="start-hint" data-testid="usage-empty-note">{note}</p> : null}
          <dl className="start-stats">
            {tiles.map(([label, value]) => (
              <div className="start-stat" key={label}>
                <dt>{label}</dt>
                <dd title={value} data-long={value.length > 12 ? '' : undefined}>
                  {value}
                </dd>
              </div>
            ))}
          </dl>
          <div className="start-heat" style={gridStyle} role="img" aria-label={t('usage.heatLabel')}>
            {heat.map((d, i) => (
              <span key={d.date} className="start-cell" data-level={levels[i + skip] ?? 0} title={`${d.date} · ${compactNumber(d.tokens)} token`} />
            ))}
          </div>
        </>
      ) : (
        <ol className="start-models">
          {data.models.length ? (
            data.models.map((m) => {
              const share = total > 0 ? m.tokens / total : 0
              const name = names.get(m.key)
              return (
                <li key={m.key} className="start-model" title={m.key}>
                  <span className="start-model-name">
                    {name?.name ?? m.key}
                    {name?.provider ? <span className="start-model-provider"> · {name.provider}</span> : null}
                  </span>
                  <span className="start-model-bar" aria-hidden>
                    <span style={{ width: `${Math.max(0.5, share * 100)}%` }} />
                  </span>
                  <span className="start-model-num">{compactNumber(m.tokens)}</span>
                  <span className="start-model-num">{share >= 0.01 ? `${Math.round(share * 100)}%` : '<1%'}</span>
                </li>
              )
            })
          ) : (
            <li className="start-hint">{t('usage.noModels')}</li>
          )}
        </ol>
      )}
    </aside>
  )
}
