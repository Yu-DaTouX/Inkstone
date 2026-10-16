import { useMemo, useState } from 'react'
import { useI18n, useT } from '../../i18n'
import { compactNumber, useMoney, useUsageStats } from '../../components/chat/UsageOverview'
import { heatLevels, tokenBreakdownOf, type UsageRange } from '../../../../shared/usage-stats'
import { renderUsageToggle } from '../../patterns/UsagePattern'
import { useStore } from '../../state/store'
import './usage-page.css'

export function UsagePage() {
  const { lang } = useI18n()
  const t = useT()
  const models = useStore((s) => s.models)
  const [range, setRange] = useState<UsageRange>('all')
  const stats = useUsageStats(range)
  const money = useMoney()
  const levels = useMemo(() => heatLevels(stats?.heat.map((day) => day.tokens) ?? []), [stats])
  const split = stats ? tokenBreakdownOf(stats) : null
  return (
    <main className="usage-page" data-testid="usage-details" aria-busy={!stats}>
      <header className="usage-page-head">
        <span className="usage-page-mark" aria-hidden>&gt;_</span>
        <h1>{stats?.userName || (lang === 'en-US' ? 'Local activity' : '本机活动')}</h1>
        <p>{t('usage.title')}</p>
      </header>
      <dl className="usage-page-stats">
        {[[t('usage.tokens'), stats ? compactNumber(stats.tokens) : '—'], [t('usage.cost'), stats ? money(stats.cost) : '—'], [t('usage.sessions'), stats?.sessions.toLocaleString() ?? '—'], [t('usage.messages'), stats ? compactNumber(stats.messages) : '—'], [t('usage.activeDays'), stats?.activeDays.toString() ?? '—']].map(([label, value]) => <div key={label}><dd>{value}</dd><dt>{label}</dt></div>)}
      </dl>
      <section className="usage-page-activity">
        <div className="usage-page-controls">
          <h2>{lang === 'en-US' ? 'Token activity' : 'Token 活动'}</h2>
          {renderUsageToggle({ kind: 'range', value: range, label: t('usage.range'), options: [{ value: 'all', label: t('usage.all') }, { value: '30d', label: t('usage.days', { n: 30 }) }, { value: '7d', label: t('usage.days', { n: 7 }) }], onChange: (value) => setRange(value as UsageRange) })}
        </div>
        <div className="usage-page-heat-scroll"><div className="start-heat usage-page-heat" aria-label={lang === 'en-US' ? 'Daily Token activity' : '每日 Token 活动'}>
          {stats?.heat.map((day, i) => <span key={day.date} className="start-cell" data-level={levels[i]} title={`${day.date} · ${day.tokens.toLocaleString()} Token`} />)}
        </div>
        <div className="usage-page-months" aria-hidden>{stats?.heat.filter((_, i) => i % 7 === 0).map((day, i, weeks) => <span key={day.date}>{i === 0 || day.date.slice(0, 7) !== weeks[i - 1].date.slice(0, 7) ? day.date.slice(5, 7) : ''}</span>)}</div>
        </div>
        <p>{split ? `${lang === 'en-US' ? 'Main sessions' : '主会话'} ${compactNumber(split.main)} · ${lang === 'en-US' ? 'Subagents' : '子代理'} ${compactNumber(split.subagents)}` : '—'}</p>
      </section>
      <section className="usage-page-models">
        <h2>{t('usage.models')}</h2>
        <ul className="start-models">{stats?.models.map((item) => {
          const model = models.find((model) => `${model.provider}/${model.id}` === item.key)
          const share = stats.tokens > 0 ? item.tokens / stats.tokens : 0
          return <li key={item.key} className="start-model"><span className="start-model-name" title={item.cost > 0 ? money(item.cost) : undefined}>{model?.name || item.key}</span><span className="start-model-num">{compactNumber(item.tokens)}</span><span className="start-model-num">{Math.round(share * 100)}%</span><span className="start-model-bar"><span style={{ width: `${share * 100}%` }} /></span></li>
        })}</ul>
      </section>
    </main>
  )
}
