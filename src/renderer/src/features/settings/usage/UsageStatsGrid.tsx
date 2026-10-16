import type { ReactElement } from 'react'
import type { UsageStatsResult } from '../../../../../shared/ipc'
import type { SettingsText } from '../settings-text'
import { compactNumber, peakHourText } from './usage-model'

/**
 * v3 设置页的用量指标网格 + Token 拆分说明（纯展示）。
 *
 * 由 `UsageSettings` 用同一次 `usageStats(range)` 结果渲染，不单独再扫一遍；
 * Token 值是含子代理与缓存读写的合计，不再拆分主会话与子代理，
 * 会话 / 消息 / 活跃天数 / 高峰时段仍只计主会话。
 */
export function UsageStatsGrid({ stats, text }: { stats: UsageStatsResult; text: SettingsText }): ReactElement {
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
