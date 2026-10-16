import type { ReactElement } from 'react'
import type { UsageStatsResult } from '../../../../../shared/ipc'
import type { SettingsText } from '../settings-text'
import { compactNumber, peakHourText } from './usage-model'
import { formatMoney } from '../../../../../shared/currency'

export function UsageStatsGrid({ stats, text, money = (usd) => formatMoney(usd, undefined) }: { stats: UsageStatsResult; text: SettingsText; money?: (usd: number) => string }): ReactElement {
  const peak = peakHourText(stats.peakHour)
  return (
    <>
      <dl className="settings-stats">
        <div className="settings-stat">
          <dt>{text.usageSessions}</dt>
          <dd>{stats.sessions.toLocaleString()}</dd>
        </div>
        <div className="settings-stat">
          <dt>{text.usageMessages}</dt>
          <dd>{compactNumber(stats.messages)}</dd>
        </div>
        <div className="settings-stat">
          <dt>{text.usageTokens}</dt>
          <dd data-testid="settings-usage-tokens" title={text.usageTokensHint}>
            {compactNumber(stats.tokens)}
          </dd>
        </div>
        <div className="settings-stat">
          <dt>{text.usageCost}</dt>
          <dd data-testid="settings-usage-cost">{money(stats.cost ?? 0)}</dd>
        </div>
        <div className="settings-stat">
          <dt>{text.usageActiveDays}</dt>
          <dd>{stats.activeDays.toLocaleString()}</dd>
        </div>
        <div className="settings-stat">
          <dt>{text.usagePeakHour}</dt>
          <dd>{peak ?? text.usagePeakNone}</dd>
        </div>
      </dl>
    </>
  )
}
