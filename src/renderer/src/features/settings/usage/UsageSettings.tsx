/**
 * 设置 → 用量（v3，WP-42）。
 *
 * 数据只来自现有聚合 `window.yan.usageStats(range)`（本机会话文件增量统计）。
 * 图表用 design/tokens 的 `--data-*` 数据色令牌画真实条形，表格与图表同源；
 * 空 / 失败都有明确状态；不估算成本。「按项目」在现有接口里没有数据，如实说明。
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { useI18n } from '../../../i18n'
import type { UsageStatsResult } from '../../../../../shared/ipc'
import type { UsageRange } from '../../../../../shared/usage-stats'
import { Button, Separator } from '../../../ui'
import { settingsText } from '../settings-text'
import { Segmented } from '../root/controls'
import {
  compactNumber,
  dailyEntries,
  shareText,
  usageBars,
  USAGE_DIMENSIONS,
  type UsageBar,
  type UsageDimension
} from './usage-model'
import { UsageStatsGrid } from './UsageStatsGrid'

type Status = 'loading' | 'ready' | 'error'
type UsageView = 'chart' | 'table'

export interface UsageSettingsProps {
  /** 「运行总览」入口；缺省由父级（S0 根）接正式 v3 路由。 */
  onOpenRuns?: () => void
}

export function UsageSettings({ onOpenRuns }: UsageSettingsProps = {}): ReactElement {
  const { lang } = useI18n()
  const text = settingsText(lang)
  const [range, setRange] = useState<UsageRange>('all')
  const [dimension, setDimension] = useState<UsageDimension>('day')
  const [view, setView] = useState<UsageView>('chart')
  const [stats, setStats] = useState<UsageStatsResult | null>(null)
  const [status, setStatus] = useState<Status>('loading')
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let alive = true
    setStatus('loading')
    setStats(null)
    window.yan
      .usageStats(range)
      .then((next) => {
        if (!alive) return
        setStats(next)
        setStatus('ready')
      })
      .catch(() => {
        if (!alive) return
        setStatus('error')
      })
    return () => {
      alive = false
    }
  }, [range, nonce])

  const retry = useCallback(() => setNonce((n) => n + 1), [])

  const rangeOptions = [
    { value: 'all' as const, label: text.rangeAll },
    { value: '30d' as const, label: text.range30 },
    { value: '7d' as const, label: text.range7 }
  ]
  const dimensionOptions = USAGE_DIMENSIONS.map((value) => ({
    value,
    label: value === 'day' ? text.usageByDay : value === 'model' ? text.usageByModel : text.usageByProject,
    testId: `v3-usage-dim-${value}`
  }))
  const viewOptions = [
    { value: 'chart' as const, label: text.usageChart, testId: 'v3-usage-view-chart' },
    { value: 'table' as const, label: text.usageTable, testId: 'v3-usage-view-table' }
  ]

  const empty = status === 'ready' && (stats?.sessions ?? 0) === 0 && (stats?.tokens ?? 0) === 0

  /* 三个维度都从真实聚合导出；「按项目」没有数据源，返回 null 走明确提示。 */
  const bars: UsageBar[] | null =
    status !== 'ready' || !stats
      ? null
      : dimension === 'day'
        ? usageBars(dailyEntries(stats.heat, range)).reverse()
        : dimension === 'model'
          ? usageBars(stats.models.map((model) => ({ key: model.key, value: model.tokens })))
          : null

  const dimensionLabel =
    dimension === 'day' ? text.usageByDay : dimension === 'model' ? text.usageByModel : text.usageByProject

  return (
    <section className="settings-section" aria-label={text.sectionUsage}>
      <p className="settings-note" role="note">
        {text.usageNote}
      </p>

      <div className="settings-usage-bar">
        <Segmented
          label={text.sectionUsage}
          value={range}
          options={rangeOptions}
          onChange={(value) => setRange(value)}
        />
        <span className="settings-spacer" />
        {onOpenRuns ? (
          <Button size="sm" variant="ghost" onPress={onOpenRuns}>
            {text.usageRuns}
          </Button>
        ) : null}
      </div>

      {status === 'loading' ? <p className="settings-value">{text.usageLoading}</p> : null}

      {status === 'error' ? (
        <div className="settings-usage-state" role="alert">
          <p className="settings-row__desc settings-row__desc--error">{text.usageError}</p>
          <Button size="sm" variant="secondary" onPress={retry}>
            {text.usageRetry}
          </Button>
        </div>
      ) : null}

      {empty ? <p className="settings-value">{text.usageEmpty}</p> : null}

      {status === 'ready' && stats && !empty ? (
        <>
          <UsageStatsGrid stats={stats} text={text} />

          <Separator />

          <div className="settings-usage-bar">
            <Segmented
              label={text.usageDimension}
              value={dimension}
              options={dimensionOptions}
              onChange={(value) => setDimension(value)}
            />
            <span className="settings-spacer" />
            <Segmented
              label={text.usageView}
              value={view}
              options={viewOptions}
              onChange={(value) => setView(value)}
            />
          </div>

          <div className="settings-breakdown" data-testid="v3-usage-breakdown" data-dimension={dimension}>
            <div className="settings-table-title">
              {dimensionLabel}
              {dimension === 'day' ? <span className="settings-breakdown__cap"> · {text.usageDailyCap}</span> : null}
            </div>

            {dimension === 'project' ? (
              <p className="settings-note" role="note" data-testid="v3-usage-project-unavailable">
                {text.usageProjectUnavailable}
              </p>
            ) : bars && bars.length > 0 ? (
              view === 'chart' ? (
                <ol className="settings-bars" aria-label={dimensionLabel}>
                  {bars.map((bar, index) => (
                    <li
                      key={bar.key}
                      className="settings-bar"
                      data-idle={bar.value > 0 ? undefined : '1'}
                      title={`${bar.label} · ${compactNumber(bar.value)} token`}
                    >
                      <span className="settings-bar__label">{bar.label}</span>
                      <span className="settings-bar__track" aria-hidden>
                        <span
                          className="settings-bar__fill"
                          style={{
                            width: `${Math.max(2, bar.ratio * 100)}%`,
                            background: dimension === 'day' ? 'var(--data-1)' : `var(--data-${(index % 8) + 1})`
                          }}
                        />
                      </span>
                      <span className="settings-bar__value">{compactNumber(bar.value)}</span>
                    </li>
                  ))}
                </ol>
              ) : (
                <div className="settings-table-wrap">
                  <table className="settings-table">
                    <thead>
                      <tr>
                        <th scope="col">
                          {dimension === 'day' ? text.usageDayColumn : text.usageModelColumn}
                        </th>
                        <th scope="col">{text.usageTokensColumn}</th>
                        <th scope="col">{text.usageShareColumn}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bars.map((bar) => (
                        <tr key={bar.key} data-idle={bar.value > 0 ? undefined : '1'}>
                          <td title={bar.key}>{bar.label}</td>
                          <td className="settings-table__num">{compactNumber(bar.value)}</td>
                          <td className="settings-table__num">{shareText(bar.share)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            ) : (
              <p className="settings-value">{dimension === 'day' ? text.usageNoDays : text.usageNoModels}</p>
            )}
          </div>
        </>
      ) : null}
    </section>
  )
}
