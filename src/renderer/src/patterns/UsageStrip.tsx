import type { JSX } from 'react'
import { compactNumber, useUsageStats } from '../features/usage/UsageOverview'
import './usage-pattern.css'
import { useUiV3 } from '../state/ui-v3'

const RECENT_DAYS = 14

export interface UsageStripText {
  label: string
  sessions: string
  days: string
  recent: string
}

export function UsageStrip({ text }: { text: UsageStripText }): JSX.Element {
  const stats = useUsageStats('all')
  const recent = stats?.heat.slice(-RECENT_DAYS) ?? []
  const peak = Math.max(1, ...recent.map((d) => d.tokens))
  return (
    <div className="start-strip" data-testid="usage-strip" aria-label={text.label} aria-busy={!stats || undefined}>
      <button className="start-details-link start-label" type="button" onClick={() => useUiV3.getState().navigate({ name: 'usage' })}>{text.label} ↗</button>
      <span className="start-strip-num">{stats ? compactNumber(stats.tokens) : '—'}</span>
      <span className="start-label">Token</span>
      <span className="start-strip-sep" aria-hidden>·</span>
      <span className="start-label">{text.sessions.replace('{n}', stats ? stats.sessions.toLocaleString() : '—')}</span>
      <span className="start-strip-sep" aria-hidden>·</span>
      <span className="start-label">{text.days.replace('{n}', stats ? String(stats.activeDays) : '—')}</span>
      <span className="start-strip-bars" role="img" aria-label={text.recent}>
        {Array.from({ length: RECENT_DAYS }, (_, i) => {
          const day = recent[i - (RECENT_DAYS - recent.length)]
          const k = day ? day.tokens / peak : 0
          return <span key={i} data-zero={k <= 0 ? '' : undefined} style={{ height: `${Math.max(12, Math.round(k * 100))}%` }} />
        })}
      </span>
    </div>
  )
}
