import type { JSX } from 'react'
import { compactNumber, useUsageStats } from '../features/usage/UsageOverview'
import './usage-pattern.css'
import { useUiV3 } from '../state/ui-v3'
import { AsciiSpark } from '../ui'
import { CELL_SIZE } from '../features/ambient/ascii-field-model'

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
  const values = Array.from({ length: RECENT_DAYS }, (_, i) => recent[i - (RECENT_DAYS - recent.length)]?.tokens ?? 0)
  return (
    <div className="start-strip" data-testid="usage-strip" aria-label={text.label} aria-busy={!stats || undefined}>
      <button className="start-details-link start-label" type="button" onClick={() => useUiV3.getState().navigate({ name: 'usage' })}>{text.label} ↗</button>
      <span className="start-strip-num">{stats ? compactNumber(stats.tokens) : '—'}</span>
      <span className="start-label">Token</span>
      <span className="start-strip-sep" aria-hidden>·</span>
      <span className="start-label">{text.sessions.replace('{n}', stats ? stats.sessions.toLocaleString() : '—')}</span>
      <span className="start-strip-sep" aria-hidden>·</span>
      <span className="start-label">{text.days.replace('{n}', stats ? String(stats.activeDays) : '—')}</span>
      <AsciiSpark key={stats ? 'ready' : 'pending'} className="start-strip-spark" label={text.recent} values={values} cell={CELL_SIZE} />
    </div>
  )
}
