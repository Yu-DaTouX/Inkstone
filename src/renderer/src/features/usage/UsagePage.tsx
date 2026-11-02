import { useMemo, useState, type CSSProperties } from 'react'
import { useI18n, useT, type MessageKey } from '../../i18n'
import { compactNumber, shareText, useMoney, useUsageStats } from './UsageOverview'
import { tokenBreakdownOf, type UsageRange } from '../../../../shared/usage-stats'
import { renderUsageToggle } from '../../patterns/UsagePattern'
import { providerFavicon } from '../../patterns/provider-favicon'
import { useStore } from '../../state/store'
import { AreaChart, PageHeader } from '../../ui'
import { settingsText } from '../settings/settings-text'
import { dailyEntries, peakHourText, usageBars, usageModelName, type UsageDimension } from '../settings/usage/usage-model'
import { UsageCurrency } from './UsageCurrency'
import './usage-page.css'

const GROUP_KEYS = new Set(['openai-codex', 'anthropic', 'google'])
const PALETTE = 4
const MIN_CHART_DAYS = 30

const providerOf = (sources: readonly string[] | undefined): string => {
  const source = sources?.[0] ?? ''
  const at = source.indexOf('/')
  return at > 0 ? source.slice(0, at) : ''
}

const shortDate = (date: string): string => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`

export function UsagePage() {
  const { lang } = useI18n()
  const t = useT()
  const text = settingsText(lang)
  const en = lang === 'en-US'
  const models = useStore((s) => s.models)
  const [range, setRange] = useState<UsageRange>('all')
  const [dimension, setDimension] = useState<UsageDimension>('model')
  const stats = useUsageStats(range)
  const money = useMoney()
  const split = stats ? tokenBreakdownOf(stats) : null
  const costSplit = stats?.costBreakdown ?? null

  const chartPoints = useMemo(() => {
    const heat = stats?.heat ?? []
    const firstActive = heat.findIndex((day) => day.tokens > 0)
    const wanted = range === '7d' ? 7 : range === '30d' ? 30 : firstActive < 0 ? MIN_CHART_DAYS : Math.max(MIN_CHART_DAYS, heat.length - firstActive)
    return heat.slice(Math.max(0, heat.length - wanted)).map((day) => ({ key: day.date, value: day.tokens, title: `${day.date} · ${day.tokens.toLocaleString()} Token` }))
  }, [stats, range])
  const axisLabels = chartPoints.length > 1
    ? [chartPoints[0].key, chartPoints[Math.floor((chartPoints.length - 1) / 2)].key, chartPoints[chartPoints.length - 1].key].map(shortDate)
    : []

  const providers = useMemo(() => {
    const order: string[] = []
    const totals = new Map<string, { tokens: number; cost: number }>()
    for (const model of stats?.models ?? []) {
      const provider = providerOf(model.sources)
      if (!totals.has(provider)) order.push(provider)
      const entry = totals.get(provider) ?? { tokens: 0, cost: 0 }
      entry.tokens += model.tokens
      entry.cost += model.cost
      totals.set(provider, entry)
    }
    const listed = order.map((provider) => ({ provider, ...totals.get(provider)! })).sort((a, b) => b.tokens - a.tokens)
    const rest = Math.max(0, (stats?.tokens ?? 0) - listed.reduce((sum, item) => sum + item.tokens, 0))
    return { listed, rest }
  }, [stats])
  const providerTone = (provider: string): number => Math.max(0, providers.listed.findIndex((item) => item.provider === provider)) % PALETTE + 1
  const providerName = (provider: string): string =>
    !provider ? (en ? 'Other' : '其他') : GROUP_KEYS.has(provider) ? t(`quota.group.${provider}` as MessageKey) : provider
  const shareTotal = providers.listed.reduce((sum, item) => sum + item.tokens, 0) + providers.rest

  const rows = !stats
    ? []
    : dimension === 'day'
      ? usageBars(dailyEntries(stats.heat, range)).reverse().filter((bar) => bar.value > 0).map((bar) => ({ ...bar, cost: null as number | null, title: bar.key, provider: null as string | null }))
      : usageBars(stats.models.map((item) => ({ key: item.key, label: usageModelName(item, models), value: item.tokens }))).map((bar, i) => ({ ...bar, cost: stats.models[i].cost, title: stats.models[i].sources?.join(' · '), provider: providerOf(stats.models[i].sources) }))

  const totals: Array<[string, string]> = [
    [t('usage.messages'), stats ? compactNumber(stats.messages) : '—'],
    [t('usage.activeDays'), stats?.activeDays.toString() ?? '—'],
    [text.usagePeakHour, stats ? peakHourText(stats.peakHour) ?? text.usagePeakNone : '—'],
    [t('usage.models'), stats ? String(stats.models.length) : '—']
  ]

  return (
    <div className="usage-page" data-testid="usage-details" aria-busy={!stats}>
      <PageHeader
        className="usage-page-head"
        size="sm"
        title={t('usage.title')}
        description={text.usageNote}
        actions={renderUsageToggle({ kind: 'range', value: range, label: t('usage.range'), options: [{ value: '7d', label: t('usage.days', { n: 7 }) }, { value: '30d', label: t('usage.days', { n: 30 }) }, { value: 'all', label: t('usage.all') }], onChange: (value) => setRange(value as UsageRange) })}
      />

      <section className="usage-page-hero">
        <div className="usage-page-total">
          <span className="usage-page-total-num ui-num" title={t('usage.tokensHint')} data-testid="usage-page-tokens">{stats ? compactNumber(stats.tokens) : '—'}</span>
          <span className="usage-page-total-sub ui-meta-num">
            {stats ? [`${stats.sessions.toLocaleString()} ${t('usage.sessions')}`, stats.cost > 0 ? money(stats.cost) : ''].filter(Boolean).join(' · ') : '—'}
          </span>
          {split ? (
            <ul className="usage-page-split">
              {([['main', en ? 'Main sessions' : '主会话', split.main, costSplit?.main ?? 0], ['subagents', en ? 'Subagents' : '子 Agent', split.subagents, costSplit?.subagents ?? 0]] as const).map(([key, label, tokens, cost]) => (
                <li key={key} data-part={key}>
                  <span className="usage-page-dot" aria-hidden="true" />
                  <span className="usage-page-split-name">{label}</span>
                  <span className="usage-page-split-val ui-num">{compactNumber(tokens)}</span>
                  <span className="usage-page-split-meta ui-meta-num">
                    {[stats && stats.tokens > 0 ? shareText(tokens / stats.tokens) : '', cost > 0 ? money(cost) : ''].filter(Boolean).join(' · ')}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <div className="usage-page-chart">
          <h2>{en ? 'Daily Token' : '每日 Token'}</h2>
          <AreaChart points={chartPoints} formatValue={compactNumber} axisLabels={axisLabels} aria-label={en ? 'Daily Token activity' : '每日 Token 活动'} />
        </div>
      </section>

      <dl className="usage-page-totals">
        {totals.map(([label, value]) => <div key={label}><dt>{label}</dt><dd className="ui-num">{value}</dd></div>)}
      </dl>

      {providers.listed.length ? (
        <section className="usage-page-providers">
          <h2>{en ? 'By provider' : '按供应商'}</h2>
          <div className="usage-page-share" aria-hidden="true">
            {providers.listed.map((item) => <i key={item.provider} style={{ flexGrow: item.tokens, '--tone': `var(--data-${providerTone(item.provider)})` } as CSSProperties} />)}
            {providers.rest > 0 ? <i style={{ flexGrow: providers.rest, '--tone': 'var(--line2)' } as CSSProperties} /> : null}
          </div>
          <ul className="usage-page-legend">
            {providers.listed.map((item) => (
              <li key={item.provider} style={{ '--tone': `var(--data-${providerTone(item.provider)})` } as CSSProperties}>
                <i aria-hidden="true" />
                <span>{providerName(item.provider)}</span>
                <b className="ui-meta-num">{item.cost > 0 ? money(item.cost) : compactNumber(item.tokens)}</b>
                <span className="ui-meta-num">{shareTotal > 0 ? shareText(item.tokens / shareTotal) : ''}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="usage-page-breakdown" data-testid="v3-usage-breakdown" data-dimension={dimension}>
        <div className="usage-page-controls">
          <h2>{text.groupUsageBreakdown}</h2>
          {renderUsageToggle({ kind: 'range', value: dimension, label: text.usageDimension, options: [{ value: 'model', label: text.usageByModel }, { value: 'day', label: text.usageByDay }], onChange: (value) => setDimension(value as UsageDimension) })}
        </div>
        {dimension === 'day' && range === 'all' ? <p className="usage-page-note">{text.usageDailyCap}</p> : null}
        {stats && rows.length === 0 ? <p className="usage-page-note">{dimension === 'day' ? text.usageNoDays : text.usageNoModels}</p> : null}
        {rows.length ? (
          <ol className="usage-page-rows">
            <li className="usage-page-row" data-head="1" aria-hidden="true">
              <span>#</span>
              <span>{dimension === 'day' ? text.usageByDay : text.usageByModel}</span>
              <span>{t('usage.cost')}</span>
              <span>%</span>
              <span>Token</span>
            </li>
            {rows.map((row, i) => {
              const icon = row.provider ? providerFavicon(row.provider) : null
              return (
                <li key={row.key} className="usage-page-row" title={row.title || row.key} style={{ '--tone': row.provider === null ? 'var(--fg3)' : `var(--data-${providerTone(row.provider)})` } as CSSProperties}>
                  <span className="ui-meta-num">{i + 1}</span>
                  <span className="usage-page-row-name">
                    <span className="usage-page-row-label">
                      {icon ? <img src={icon} alt="" aria-hidden="true" /> : null}
                      <span>{row.label}</span>
                    </span>
                    <span className="usage-page-row-bar" style={{ width: `${Math.max(2, row.ratio * 100)}%` }} aria-hidden="true" />
                  </span>
                  <span className="ui-num">{row.cost != null && row.cost > 0 ? money(row.cost) : ''}</span>
                  <span className="ui-meta-num">{row.value > 0 ? shareText(row.share) : ''}</span>
                  <span className="ui-num">{compactNumber(row.value)}</span>
                </li>
              )
            })}
          </ol>
        ) : null}
      </section>
      <UsageCurrency text={text} />
    </div>
  )
}
