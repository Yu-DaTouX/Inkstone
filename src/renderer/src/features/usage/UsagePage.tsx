import { memo, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { useI18n, useT, type MessageKey } from '../../i18n'
import { compactNumber, shareText, useMoney, useUsageStatsState } from './UsageOverview'
import { tokenBreakdownOf, type UsageRange, type UsageStatsView } from '../../../../shared/usage-stats'
import type { ModelInfo } from '../../../../shared/ipc'
import { renderUsageToggle } from '../../patterns/UsagePattern'
import { providerFavicon } from '../../patterns/provider-favicon'
import { useStore } from '../../state/store'
import { AreaChart, Button, Notice, PageHeader } from '../../ui'
import { settingsText } from '../settings/settings-text'
import { peakHourText, type UsageDimension } from '../settings/usage/usage-model'
import { providerOf, usageChartData, usageDayRows, usageModelRows } from './usage-page-data'
import { UsageCurrency } from './UsageCurrency'
import './usage-page.css'

const GROUP_KEYS = new Set(['openai-codex', 'anthropic', 'google'])
const PALETTE = 4
const EMPTY_HEAT: UsageStatsView['heat'] = []
const EMPTY_ENTRIES: UsageStatsView['models'] = []
const EMPTY_MODELS: readonly ModelInfo[] = []
const UsageChart = memo(AreaChart)

export function UsagePage() {
  const { lang } = useI18n()
  const t = useT()
  const text = settingsText(lang)
  const en = lang === 'en-US'
  const authProviders = useStore((s) => s.authProviders)
  const loadAuthProviders = useStore((s) => s.loadAuthProviders)
  useEffect(() => {
    if (useStore.getState().authProviders.length === 0) void loadAuthProviders()
  }, [loadAuthProviders])
  const [range, setRange] = useState<UsageRange>('all')
  const [dimension, setDimension] = useState<UsageDimension>('model')
  const { stats, failed, retry } = useUsageStatsState(range)
  const entries = stats?.models ?? EMPTY_ENTRIES
  const heat = stats?.heat ?? EMPTY_HEAT
  const showModels = dimension === 'model' && entries.length > 0
  const models = useStore((s) => showModels ? s.models : EMPTY_MODELS)
  const money = useMoney()
  const split = stats ? tokenBreakdownOf(stats) : null
  const costSplit = stats?.costBreakdown ?? null

  const { points: chartPoints, axisLabels } = useMemo(() => usageChartData(heat, range), [heat, range])

  const providers = useMemo(() => {
    const order: string[] = []
    const totals = new Map<string, { tokens: number; cost: number }>()
    for (const model of entries) {
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
  }, [entries, stats?.tokens])
  const providerTone = (provider: string): number => Math.max(0, providers.listed.findIndex((item) => item.provider === provider)) % PALETTE + 1
  const providerName = (provider: string): string =>
    !provider ? (en ? 'Other' : '其他') : GROUP_KEYS.has(provider) ? t(`quota.group.${provider}` as MessageKey) : authProviders.find((info) => info.id === provider)?.name?.trim() || provider
  const shareTotal = providers.listed.reduce((sum, item) => sum + item.tokens, 0) + providers.rest

  const modelRows = useMemo(() => showModels ? usageModelRows(entries, models) : [], [showModels, entries, models])
  const dayRows = useMemo(() => usageDayRows(heat, range), [heat, range])
  const rows = dimension === 'day' ? dayRows : modelRows

  const totals: Array<[string, string]> = [
    [t('usage.messages'), stats ? compactNumber(stats.messages) : '—'],
    [t('usage.activeDays'), stats?.activeDays.toString() ?? '—'],
    [text.usagePeakHour, stats ? peakHourText(stats.peakHour) ?? text.usagePeakNone : '—'],
    [t('usage.models'), stats ? String(stats.models.length) : '—']
  ]

  return (
    <div className="usage-page" data-testid="usage-details" aria-busy={!stats && !failed}>
      <PageHeader
        className="usage-page-head"
        size="sm"
        title={t('usage.title')}
        description={text.usageNote}
        actions={renderUsageToggle({ kind: 'range', value: range, label: t('usage.range'), options: [{ value: '7d', label: t('usage.days', { n: 7 }) }, { value: '30d', label: t('usage.days', { n: 30 }) }, { value: 'all', label: t('usage.all') }], onChange: (value) => setRange(value as UsageRange) })}
      />

      {failed && !stats ? (
        <Notice className="usage-page-error" tone="fail" action={<Button size="sm" variant="secondary" onPress={retry}>{t('usage.retry')}</Button>} data-testid="usage-page-error">
          {t('usage.loadFailed')}
        </Notice>
      ) : null}

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
          <UsageChart points={chartPoints} formatValue={compactNumber} axisLabels={axisLabels} aria-label={en ? 'Daily Token activity' : '每日 Token 活动'} />
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
                <b className="ui-meta-num">{compactNumber(item.tokens)}</b>
                <span className="ui-meta-num">{[shareTotal > 0 ? shareText(item.tokens / shareTotal) : '', item.cost > 0 ? money(item.cost) : ''].filter(Boolean).join(' · ')}</span>
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
          <ol className="usage-page-rows" role="table" aria-label={text.groupUsageBreakdown}>
            <li className="usage-page-row" data-head="1" role="row">
              <span role="columnheader">#</span>
              <span role="columnheader">{dimension === 'day' ? text.usageByDay : text.usageByModel}</span>
              {dimension === 'day' ? null : <span role="columnheader">{t('usage.cost')}</span>}
              <span role="columnheader">%</span>
              <span role="columnheader">Token</span>
            </li>
            {rows.map((row, i) => {
              const icon = row.provider ? providerFavicon(row.provider) : null
              return (
                <li key={row.key} className="usage-page-row" role="row" title={row.title || row.key} style={{ '--tone': row.provider === null ? 'var(--fg3)' : `var(--data-${providerTone(row.provider)})` } as CSSProperties}>
                  <span className="ui-meta-num" role="cell">{i + 1}</span>
                  <span className="usage-page-row-name" role="cell">
                    <span className="usage-page-row-label">
                      {icon ? <img src={icon} alt="" aria-hidden="true" /> : dimension === 'day' ? null : <i className="usage-page-row-icon" aria-hidden="true" />}
                      <span>{row.label}</span>
                    </span>
                    <span className="usage-page-row-bar" style={{ width: `${Math.max(2, row.ratio * 100)}%` }} aria-hidden="true" />
                  </span>
                  {dimension === 'day' ? null : <span className="ui-num" role="cell">{row.cost != null && (row.cost > 0 || row.free) ? money(row.cost) : '—'}</span>}
                  <span className="ui-meta-num" role="cell">{row.value > 0 ? shareText(row.share) : ''}</span>
                  <span className="ui-num" role="cell">{compactNumber(row.value)}</span>
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
