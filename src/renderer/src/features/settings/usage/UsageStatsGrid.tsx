import type { ReactElement } from 'react'
import type { UsageStatsResult } from '../../../../../shared/ipc'
import type { SettingsText } from '../settings-text'
import { compactNumber } from '../../usage/usage-format'
import { peakHourText } from './usage-model'
import { formatMoney } from '../../../../../shared/currency'
import { useTweenedNumber } from '../root/use-tweened-number'

function Tweened({ value, format }: { value: number; format: (n: number) => string }): ReactElement {
  return <>{format(useTweenedNumber(value))}</>
}

const wholeNumber = (n: number): string => Math.round(n).toLocaleString()

export function UsageStatsGrid({ stats, text, money = (usd) => formatMoney(usd, undefined) }: { stats: UsageStatsResult; text: SettingsText; money?: (usd: number) => string }): ReactElement {
  const peak = peakHourText(stats.peakHour)
  return (
    <>
      <dl className="settings-stats">
        <div className="settings-stat">
          <dt>{text.usageSessions}</dt>
          <dd>
            <Tweened value={stats.sessions} format={wholeNumber} />
          </dd>
        </div>
        <div className="settings-stat">
          <dt>{text.usageMessages}</dt>
          <dd>
            <Tweened value={stats.messages} format={(n) => compactNumber(Math.round(n))} />
          </dd>
        </div>
        <div className="settings-stat">
          <dt>{text.usageTokens}</dt>
          <dd data-testid="settings-usage-tokens" title={text.usageTokensHint}>
            <Tweened value={stats.tokens} format={(n) => compactNumber(Math.round(n))} />
          </dd>
        </div>
        <div className="settings-stat">
          <dt>{text.usageCost}</dt>
          <dd data-testid="settings-usage-cost">
            <Tweened value={stats.cost ?? 0} format={money} />
          </dd>
        </div>
        <div className="settings-stat">
          <dt>{text.usageActiveDays}</dt>
          <dd>
            <Tweened value={stats.activeDays} format={wholeNumber} />
          </dd>
        </div>
        <div className="settings-stat">
          <dt>{text.usagePeakHour}</dt>
          <dd>{peak ?? text.usagePeakNone}</dd>
        </div>
      </dl>
    </>
  )
}
