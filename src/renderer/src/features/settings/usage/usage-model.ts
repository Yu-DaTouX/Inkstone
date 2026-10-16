/**
 * 用量页的纯展示逻辑（可在无 React / DOM 环境单测）。
 */
import type { UsageRange } from '../../../../../shared/usage-stats'

/** 用量范围与展示顺序：与主进程 `usageStats(range)` 的取值一致。 */
export const USAGE_RANGES: readonly UsageRange[] = ['all', '30d', '7d']

/** 图表 / 表格的分组维度：按日、按模型、按项目。 */
export type UsageDimension = 'day' | 'model' | 'project'
export const USAGE_DIMENSIONS: readonly UsageDimension[] = ['day', 'model', 'project']

/** 按日图表与表格最多展示的天数（接口的 heat 最长约 26 周，全量铺开会压垮版面）。 */
export const DAILY_MAX_DAYS = 30

/** 大数压缩：与启动页用量同一口径（1e4 起用 K，1e6 起 M，1e9 起 B）。 */
export function compactNumber(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`
  if (n >= 1e4) return `${(n / 1e3).toFixed(0)}K`
  return Math.round(n).toLocaleString()
}

/** 某个模型占总 token 的比例 0–1；总数为 0 时返回 0，不产生 NaN。 */
export function modelShare(tokens: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0
  return Math.min(1, Math.max(0, tokens / total))
}

/** 占比文案：小于 1% 显示 `<1%`，其余四舍五入到整数。 */
export function shareText(share: number): string {
  return share >= 0.01 ? `${Math.round(share * 100)}%` : '<1%'
}

/** 高峰时段：0–23 → `09:00` 形式；没有数据返回 null。 */
export function peakHourText(hour: number | null): string | null {
  if (hour === null || !Number.isInteger(hour) || hour < 0 || hour > 23) return null
  return `${String(hour).padStart(2, '0')}:00`
}

/** 图表 / 表格的一行；`ratio` 是相对当前分组最大值的比例（画条形用），`share` 占总量的比例。 */
export interface UsageBar {
  key: string
  label: string
  value: number
  /** 占当前分组总量的比例 0–1；总量为 0 时为 0 */
  share: number
  /** 相对当前分组最大值的比例 0–1；用于画条形，最大值为 0 时为 0 */
  ratio: number
}

/** 把「键 + token 数」的条目转成可画表/画图的行；空数组返回空数组。 */
export function usageBars(entries: ReadonlyArray<{ key: string; label?: string; value: number }>): UsageBar[] {
  const total = entries.reduce((sum, entry) => sum + Math.max(0, entry.value), 0)
  const max = entries.reduce((m, entry) => Math.max(m, Math.max(0, entry.value)), 0)
  return entries.map((entry) => ({
    key: entry.key,
    label: entry.label ?? entry.key,
    value: entry.value,
    share: modelShare(entry.value, total),
    ratio: max > 0 ? Math.min(1, Math.max(0, entry.value / max)) : 0
  }))
}

/**
 * 按日序列：heat 是连续日（截止今天），按范围取尾部；`all` 也最多展示 DAILY_MAX_DAYS 天。
 * 保持时间升序，方便表格按日期阅读。
 */
export function dailyEntries(
  heat: ReadonlyArray<{ date: string; tokens: number }>,
  range: UsageRange
): Array<{ key: string; label: string; value: number }> {
  const wanted = range === '7d' ? 7 : range === '30d' ? 30 : heat.length
  const take = Math.min(wanted, DAILY_MAX_DAYS)
  return heat.slice(Math.max(0, heat.length - take)).map((day) => ({ key: day.date, label: day.date, value: day.tokens }))
}
