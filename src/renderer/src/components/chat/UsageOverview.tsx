import { useEffect, useState } from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import type { UsageRange } from '../../../../shared/usage-stats'
import type { UsageStatsResult } from '../../../../shared/ipc'
import { UsageOverviewView, type UsageOverviewTab, type UsageToggleRenderer } from './UsageOverviewView'

/**
 * 启动页的本机用量（容器）：按范围请求一次 `usageStats(range)`，把结果交给纯展示层
 * `UsageOverviewView` 排版。数据来自本机会话文件（主进程增量统计），不联网。
 * 取不到或没有历史时缺省整段不显示（v2）；v3 传 `keepWhenEmpty` 保留框架，不整块消失。
 *
 * `renderToggle` 由外壳注入：v2 缺省用展示件的文字按钮，v3 传 `Tabs` 原语。
 */

/* 本次运行内记住上次结果：回到空会话时先显示旧值，后台刷新 */
const memo = new Map<UsageRange, UsageStatsResult>()

export { compactNumber } from './UsageOverviewView'

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

  return (
    <UsageOverviewView
      stats={stats}
      range={range}
      tab={tab}
      models={models}
      t={t}
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
