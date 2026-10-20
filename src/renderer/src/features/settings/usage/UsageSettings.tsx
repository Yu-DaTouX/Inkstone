import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { useI18n } from '../../../i18n'
import type { UsageStatsResult } from '../../../../../shared/ipc'
import type { UsageRange } from '../../../../../shared/usage-stats'
import { Button } from '../../../ui'
import { settingsText } from '../settings-text'
import { Segmented, SettingsGroup } from '../root/controls'
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
import { UsageCurrency } from './UsageCurrency'
import { useMoney } from '../../usage/UsageOverview'
import './usage-settings.css'

type Status = 'loading' | 'ready' | 'error'
type UsageView = 'chart' | 'table'

export function UsageSettings(): ReactElement {
  const { lang } = useI18n()
  const text = settingsText(lang)
  const [range, setRange] = useState<UsageRange>('all')
  const [dimension, setDimension] = useState<UsageDimension>('day')
  const [view, setView] = useState<UsageView>('chart')
  const [stats, setStats] = useState<UsageStatsResult | null>(null)
  const [status, setStatus] = useState<Status>('loading')
  const [nonce, setNonce] = useState(0)
  const money = useMoney()

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
    label: value === 'day' ? text.usageByDay : text.usageByModel,
    testId: `v3-usage-dim-${value}`
  }))
  const viewOptions = [
    { value: 'chart' as const, label: text.usageChart, testId: 'v3-usage-view-chart' },
    { value: 'table' as const, label: text.usageTable, testId: 'v3-usage-view-table' }
  ]

  const empty = status === 'ready' && (stats?.sessions ?? 0) === 0 && (stats?.tokens ?? 0) === 0

  const bars: UsageBar[] | null =
    status !== 'ready' || !stats
      ? null
      : dimension === 'day'
        ? usageBars(dailyEntries(stats.heat, range)).reverse()
        : usageBars(stats.models.map((model) => ({ key: model.key, value: model.tokens })))

  const dimensionLabel = dimension === 'day' ? text.usageByDay : text.usageByModel

  return (
    <section className="settings-section" aria-label={text.sectionUsage}>
      <SettingsGroup
        title={text.groupUsageOverview}
        description={text.usageNote}
        settingId="usage-range"
        plain
        actions={<Segmented label={text.sectionUsage} value={range} options={rangeOptions} onChange={(value) => setRange(value)} />}
      >
        <div className="usage-panel">
          {status === 'loading' ? <p className="settings-value usage-panel__state">{text.usageLoading}</p> : null}

          {status === 'error' ? (
            <div className="settings-usage-state usage-panel__state" role="alert">
              <p className="settings-row__desc settings-row__desc--error">{text.usageError}</p>
              <Button variant="secondary" onPress={retry}>
                {text.usageRetry}
              </Button>
            </div>
          ) : null}

          {empty ? <p className="settings-value usage-panel__state">{text.usageEmpty}</p> : null}

          {status === 'ready' && stats && !empty ? <UsageStatsGrid stats={stats} text={text} money={money} /> : null}
        </div>
      </SettingsGroup>

      {status === 'ready' && stats && !empty ? (
        <SettingsGroup
          title={text.groupUsageBreakdown}
          description={
            <>
              {dimensionLabel}
              {dimension === 'day' ? <span className="settings-breakdown__cap"> · {text.usageDailyCap}</span> : null}
            </>
          }
          settingId="usage-breakdown"
          plain
          actions={
            <>
              <Segmented label={text.usageDimension} value={dimension} options={dimensionOptions} onChange={(value) => setDimension(value)} />
              <Segmented label={text.usageView} value={view} options={viewOptions} onChange={(value) => setView(value)} />
            </>
          }
        >
          <div className="usage-panel">
            <div className="settings-breakdown" data-testid="v3-usage-breakdown" data-dimension={dimension}>
              {bars && bars.length > 0 ? (
                view === 'chart' ? (
                  <ol className="settings-bars" data-dimension={dimension} aria-label={dimensionLabel}>
                    {bars.map((bar, index) => (
                      <li
                        key={bar.key}
                        className="settings-bar"
                        data-idle={bar.value > 0 ? undefined : '1'}
                        title={`${bar.label} · ${compactNumber(bar.value)} token`}
                      >
                        <span className="settings-bar__label">{bar.label}</span>
                        <span className="settings-bar__track" aria-hidden>
                          {bar.value > 0 ? (
                            <span
                              className="settings-bar__fill"
                              style={{
                                transform: `scaleX(${Math.max(0.02, bar.ratio)})`,
                                background: dimension === 'day' ? 'var(--data-1)' : `var(--data-${(index % 8) + 1})`
                              }}
                            />
                          ) : null}
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
                          {dimension === 'model' ? <th scope="col">{text.usageCostColumn}</th> : null}
                        </tr>
                      </thead>
                      <tbody>
                        {bars.map((bar) => (
                          <tr key={bar.key} data-idle={bar.value > 0 ? undefined : '1'}>
                            <td title={bar.key}>{bar.label}</td>
                            <td className="settings-table__num">{compactNumber(bar.value)}</td>
                            <td className="settings-table__num">{shareText(bar.share)}</td>
                            {dimension === 'model' ? <td className="settings-table__num">{money(stats?.models.find((model) => model.key === bar.key)?.cost ?? 0)}</td> : null}
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
          </div>
        </SettingsGroup>
      ) : null}

      <SettingsGroup title={text.groupUsageCurrency}>
        <UsageCurrency text={text} />
      </SettingsGroup>
    </section>
  )
}
