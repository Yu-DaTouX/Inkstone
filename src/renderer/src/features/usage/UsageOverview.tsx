import { useCallback, useEffect, useState } from 'react'
import { useI18n } from '../../i18n'
import { useStore } from '../../state/store'
import type { UsageRange } from '../../../../shared/usage-stats'
import type { UsageStatsResult } from '../../../../shared/ipc'
import { formatMoney } from '../../../../shared/currency'

export { compactNumber, shareText } from './usage-format'

export function useMoney(): (usd: number, compact?: boolean) => string {
  const { lang } = useI18n()
  const currency = useStore((s) => s.settings?.usageCurrency)
  return useCallback((usd: number, compact = false) => formatMoney(usd, currency, lang, compact), [currency, lang])
}

const usageMemory = new Map<UsageRange, UsageStatsResult>()
const usageInflight = new Map<UsageRange, Promise<UsageStatsResult>>()

function loadUsageStats(range: UsageRange): Promise<UsageStatsResult> {
  const running = usageInflight.get(range)
  if (running) return running
  const next = window.yan
    .usageStats(range)
    .then((result) => {
      usageMemory.set(range, result)
      return result
    })
    .finally(() => usageInflight.delete(range))
  usageInflight.set(range, next)
  return next
}

export function prefetchUsageStats(): void {
  void loadUsageStats('all').catch(() => undefined)
}

export interface UsageStatsState {
  stats: UsageStatsResult | null
  failed: boolean
  retry: () => void
}

export function useUsageStatsState(range: UsageRange): UsageStatsState {
  const [stats, setStats] = useState<UsageStatsResult | null>(() => usageMemory.get(range) ?? null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let alive = true
    setStats(usageMemory.get(range) ?? null)
    setFailed(false)
    loadUsageStats(range)
      .then((next) => {
        if (alive) setStats(next)
      })
      .catch(() => {
        if (alive) setFailed(true)
      })
    return () => {
      alive = false
    }
  }, [range, attempt])
  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  return { stats, failed, retry }
}

export function useUsageStats(range: UsageRange): UsageStatsResult | null {
  return useUsageStatsState(range).stats
}
