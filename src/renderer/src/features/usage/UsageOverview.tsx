import { useCallback, useEffect, useState } from 'react'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import type { UsageRange } from '../../../../shared/usage-stats'
import type { UsageStatsResult } from '../../../../shared/ipc'
import { formatMoney } from '../../../../shared/currency'
import { UsageOverviewView, type UsageOverviewTab, type UsageToggleRenderer } from './UsageOverviewView'

const memo = new Map<UsageRange, UsageStatsResult>()

export { compactNumber } from './UsageOverviewView'

export function useMoney(): (usd: number) => string {
  const { lang } = useI18n()
  const currency = useStore((s) => s.settings?.usageCurrency)
  return useCallback((usd: number) => formatMoney(usd, currency, lang), [currency, lang])
}

export function useUsageStats(range: UsageRange): UsageStatsResult | null {
  const [stats, setStats] = useState<UsageStatsResult | null>(() => memo.get(range) ?? null)
  useEffect(() => {
    let alive = true
    setStats(memo.get(range) ?? null)
    window.yan
      .usageStats(range)
      .then((next) => {
        memo.set(range, next)
        if (alive) setStats(next)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [range])
  return stats
}

export function UsageOverview({ renderToggle, keepWhenEmpty, emptyNote, onOpenDetails, compact }: { renderToggle?: UsageToggleRenderer; keepWhenEmpty?: boolean; emptyNote?: string; onOpenDetails?: () => void; compact?: boolean } = {}) {
  const t = useT()
  const [tab, setTab] = useState<UsageOverviewTab>('overview')
  const [range, setRange] = useState<UsageRange>('all')
  const stats = useUsageStats(range)
  const models = useStore((s) => s.models)
  const money = useMoney()

  return (
    <UsageOverviewView
      stats={stats}
      range={range}
      tab={tab}
      models={models}
      t={t}
      money={money}
      onTabChange={setTab}
      onRangeChange={setRange}
      renderToggle={renderToggle}
      keepWhenEmpty={keepWhenEmpty}
      emptyNote={emptyNote}
      onOpenDetails={onOpenDetails}
      compact={compact}
    />
  )
}
