import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import type { TFunc } from '../../i18n'
import { HEAT_WEEKS, heatLevels, localDay, type UsageRange } from '../../../../shared/usage-stats'
import type { ModelInfo, UsageStatsResult } from '../../../../shared/ipc'

const HEAT_SHOWN = 20

export function compactNumber(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`
  if (n >= 1e4) return `${(n / 1e3).toFixed(0)}K`
  return n.toLocaleString()
}

export interface UsageToggleProps {
  kind: 'tab' | 'range'
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string) => void
  label: string
  testId?: string
}
export type UsageToggleRenderer = (props: UsageToggleProps) => ReactNode

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
    cost: 0,
    costBreakdown: { main: 0, subagents: 0 },
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
  models: ModelInfo[]
  t: TFunc
  money?: (usd: number) => string
  onTabChange: (tab: UsageOverviewTab) => void
  onRangeChange: (range: UsageRange) => void
  renderToggle?: UsageToggleRenderer
  keepWhenEmpty?: boolean
  emptyNote?: string
}

export function UsageOverviewView({
  stats,
  range,
  tab,
  models,
  t,
  money,
  onTabChange,
  onRangeChange,
  renderToggle,
  keepWhenEmpty = false,
  emptyNote,
  onOpenDetails,
  compact = false
}: UsageOverviewViewProps) {
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
  const noHistory = !!stats && range === 'all' && stats.sessions === 0 && stats.tokens === 0
  if (!keepWhenEmpty && (!stats || noHistory)) return null
  const pending = !stats
  const note = noHistory ? emptyNote : undefined
  const data = stats ?? emptyUsageStats(range)
  const dash = (value: string): string => (pending ? '—' : value)

  const tiles: Array<[string, string]> = [
    [t('usage.sessions'), dash(data.sessions.toLocaleString())],
    [t('usage.messages'), dash(compactNumber(data.messages))],
    [t('usage.activeDays'), dash(String(data.activeDays))]
  ]
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
            {money && data.cost > 0 ? <span className="start-label" data-testid="usage-cost" title={t('usage.costHint')}>· {dash(money(data.cost))}</span> : null}
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
