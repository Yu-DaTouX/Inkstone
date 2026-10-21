import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useI18n, useT } from '../../i18n'
import { compactNumber, useMoney, useUsageStats } from './UsageOverview'
import { heatLevels, tokenBreakdownOf, type UsageRange } from '../../../../shared/usage-stats'
import { renderUsageToggle } from '../../patterns/UsagePattern'
import { useStore } from '../../state/store'
import { PageHeader } from '../../ui'
import { settingsText } from '../settings/settings-text'
import { dailyEntries, peakHourText, shareText, usageBars, type UsageDimension } from '../settings/usage/usage-model'
import { UsageCurrency } from './UsageCurrency'
import './usage-page.css'

export function UsagePage() {
  const { lang } = useI18n()
  const t = useT()
  const text = settingsText(lang)
  const models = useStore((s) => s.models)
  const [range, setRange] = useState<UsageRange>('all')
  const [dimension, setDimension] = useState<UsageDimension>('model')
  const stats = useUsageStats(range)
  const money = useMoney()
  const levels = useMemo(() => heatLevels(stats?.heat.map((day) => day.tokens) ?? []), [stats])
  const split = stats ? tokenBreakdownOf(stats) : null
  const heatScroll = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = heatScroll.current
    if (!el) return
    const toLatest = (): void => { el.scrollLeft = el.scrollWidth }
    toLatest()
    const observer = new ResizeObserver(toLatest)
    observer.observe(el)
    return () => observer.disconnect()
  }, [stats])
  const modelName = (key: string): string => models.find((model) => `${model.provider}/${model.id}` === key)?.name || key
  const rows = !stats
    ? []
    : dimension === 'day'
      ? usageBars(dailyEntries(stats.heat, range)).reverse().map((bar) => ({ ...bar, cost: null as number | null }))
      : usageBars(stats.models.map((item) => ({ key: item.key, label: modelName(item.key), value: item.tokens }))).map((bar, i) => ({ ...bar, cost: stats.models[i].cost }))
  const tiles: Array<[string, string]> = [
    [t('usage.tokens'), stats ? compactNumber(stats.tokens) : '—'],
    [t('usage.cost'), stats ? money(stats.cost) : '—'],
    [t('usage.sessions'), stats?.sessions.toLocaleString() ?? '—'],
    [t('usage.messages'), stats ? compactNumber(stats.messages) : '—'],
    [t('usage.activeDays'), stats?.activeDays.toString() ?? '—'],
    [text.usagePeakHour, stats ? peakHourText(stats.peakHour) ?? text.usagePeakNone : '—']
  ]
  return (
    <div className="usage-page" data-testid="usage-details" aria-busy={!stats}>
      <PageHeader
        className="usage-page-head"
        title={t('usage.title')}
        description={text.usageNote}
        actions={renderUsageToggle({ kind: 'range', value: range, label: t('usage.range'), options: [{ value: 'all', label: t('usage.all') }, { value: '30d', label: t('usage.days', { n: 30 }) }, { value: '7d', label: t('usage.days', { n: 7 }) }], onChange: (value) => setRange(value as UsageRange) })}
      />
      <dl className="usage-page-stats">
        {tiles.map(([label, value]) => <div key={label}><dt>{label}</dt><dd title={label === t('usage.tokens') ? t('usage.tokensHint') : undefined}>{value}</dd></div>)}
      </dl>
      <section className="usage-page-activity">
        <div className="usage-page-controls">
          <h2>{lang === 'en-US' ? 'Token activity' : 'Token 活动'}</h2>
          <p>{split ? `${lang === 'en-US' ? 'Main sessions' : '主会话'} ${compactNumber(split.main)} · ${lang === 'en-US' ? 'Subagents' : '子 Agent'} ${compactNumber(split.subagents)}` : '—'}</p>
        </div>
        <div ref={heatScroll} className="usage-page-heat-scroll"><div className="start-heat usage-page-heat" aria-label={lang === 'en-US' ? 'Daily Token activity' : '每日 Token 活动'}>
          {stats?.heat.map((day, i) => <span key={day.date} className="start-cell" data-level={levels[i]} title={`${day.date} · ${day.tokens.toLocaleString()} Token`} />)}
        </div>
        <div className="usage-page-months" aria-hidden>{stats?.heat.filter((_, i) => i % 7 === 0).map((day, i) => {
            const week = stats.heat.slice(i * 7, i * 7 + 7)
            const monthStart = week.find((d) => d.date.slice(8, 10) === '01')
            const nextWeekStartsMonth = i === 0 && stats.heat.slice(7, 14).some((d) => d.date.slice(8, 10) === '01')
            return <span key={day.date}>{monthStart ? monthStart.date.slice(5, 7) : i === 0 && !nextWeekStartsMonth ? day.date.slice(5, 7) : ''}</span>
          })}</div>
        </div>
      </section>
      <section className="usage-page-breakdown" data-testid="v3-usage-breakdown" data-dimension={dimension}>
        <div className="usage-page-controls">
          <h2>{text.groupUsageBreakdown}</h2>
          {renderUsageToggle({ kind: 'range', value: dimension, label: text.usageDimension, options: [{ value: 'model', label: text.usageByModel }, { value: 'day', label: text.usageByDay }], onChange: (value) => setDimension(value as UsageDimension) })}
        </div>
        {dimension === 'day' && range === 'all' ? <p className="usage-page-note">{text.usageDailyCap}</p> : null}
        {stats && rows.length === 0 ? <p className="usage-page-note">{dimension === 'day' ? text.usageNoDays : text.usageNoModels}</p> : null}
        <ul className="start-models usage-page-rows">{rows.map((row) => (
          <li key={row.key} className="start-model" data-idle={row.value > 0 ? undefined : ''} title={row.key}>
            <span className="start-model-name">{row.label}</span>
            <span className="start-model-num usage-page-cost">{row.cost != null && row.cost > 0 ? money(row.cost) : ''}</span>
            <span className="start-model-num">{compactNumber(row.value)}</span>
            <span className="start-model-num">{row.value > 0 ? shareText(row.share) : ''}</span>
            <span className="start-model-bar" aria-hidden><span style={{ width: `${row.ratio * 100}%` }} /></span>
          </li>
        ))}</ul>
      </section>
      <UsageCurrency text={text} />
    </div>
  )
}
