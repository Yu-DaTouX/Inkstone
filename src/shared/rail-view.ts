/**
 * 左栏「视图」的纯计算：把会话按所选分组方式与排序整理成分区。
 *
 * 渲染层只负责画分区与会话行；分区怎么分、谁排在前都在这里，
 * 这样「按状态」「按日期」的边界（跨零点、运行实例缺失）能用单测钉死。
 * 「按项目」仍由左栏的项目树负责，这里不处理。
 */

export type RailGroupBy = 'project' | 'state' | 'date' | 'none'
export type RailSortBy = 'recent' | 'name' | 'created'

/** 显示进行中的会话，还是已归档的。 */
export type RailShow = 'active' | 'archived'

export interface RailView {
  group: RailGroupBy
  sort: RailSortBy
  show: RailShow
}

export const DEFAULT_RAIL_VIEW: RailView = { group: 'project', sort: 'recent', show: 'active' }

const GROUPS: readonly RailGroupBy[] = ['project', 'state', 'date', 'none']
const SORTS: readonly RailSortBy[] = ['recent', 'name', 'created']

/** 从存储里读回的值可能是旧版本或被改坏的，逐项校验，坏了回默认。 */
export function normalizeRailView(raw: unknown): RailView {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof RailView, unknown>>
  return {
    group: GROUPS.includes(o.group as RailGroupBy) ? (o.group as RailGroupBy) : DEFAULT_RAIL_VIEW.group,
    sort: SORTS.includes(o.sort as RailSortBy) ? (o.sort as RailSortBy) : DEFAULT_RAIL_VIEW.sort,
    show: o.show === 'archived' ? 'archived' : 'active'
  }
}

/** 一条会话参与分区所需的最小字段（SessionSummary 的子集）。 */
export interface RailViewItem {
  path: string
  title: string
  createdAt: number
  updatedAt: number
  lastActivityAt?: number
}

export type RailRunState = 'waiting' | 'failed' | 'running' | 'idle'

export type RailSectionKey = 'waiting' | 'failed' | 'running' | 'idle' | 'today' | 'yesterday' | 'week' | 'older' | 'all'

export interface RailSection<T extends RailViewItem> {
  key: RailSectionKey
  items: T[]
}

const activityOf = (s: RailViewItem): number => s.lastActivityAt ?? s.updatedAt

/** 排序比较器；名称用 localeCompare（中文按拼音序，数字按自然序），同名时回落到最近活动。 */
export function compareBy(sort: RailSortBy): (a: RailViewItem, b: RailViewItem) => number {
  if (sort === 'name') {
    return (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }) || activityOf(b) - activityOf(a)
  }
  if (sort === 'created') return (a, b) => b.createdAt - a.createdAt || activityOf(b) - activityOf(a)
  return (a, b) => activityOf(b) - activityOf(a)
}

/** 本地日期的零点（毫秒）。用本地时区：「今天」是用户的今天，不是 UTC 的今天。 */
function startOfDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 按日期分区；分区键按「相对今天」算，跨零点后下一次渲染自然归位。 */
export function dateSectionOf(ms: number, now: number): RailSectionKey {
  const today = startOfDay(now)
  const day = 86_400_000
  if (ms >= today) return 'today'
  if (ms >= today - day) return 'yesterday'
  if (ms >= today - 6 * day) return 'week'
  return 'older'
}

const STATE_ORDER: readonly RailRunState[] = ['waiting', 'failed', 'running', 'idle']
const DATE_ORDER: readonly RailSectionKey[] = ['today', 'yesterday', 'week', 'older']

/**
 * 整理成分区；空分区不返回。`group === 'project'` 不在这里处理，返回空数组。
 * `stateOf` 取不到运行实例的会话一律当 idle（没有实例 ≠ 出错）。
 */
export function buildRailSections<T extends RailViewItem>(
  items: readonly T[],
  view: RailView,
  stateOf: (item: T) => RailRunState,
  now: number
): RailSection<T>[] {
  if (view.group === 'project') return []
  const sorted = [...items].sort(compareBy(view.sort))
  if (view.group === 'none') return sorted.length ? [{ key: 'all', items: sorted }] : []

  const buckets = new Map<RailSectionKey, T[]>()
  for (const item of sorted) {
    const key: RailSectionKey = view.group === 'state' ? stateOf(item) : dateSectionOf(activityOf(item), now)
    const list = buckets.get(key) ?? []
    list.push(item)
    buckets.set(key, list)
  }
  const order: readonly RailSectionKey[] = view.group === 'state' ? STATE_ORDER : DATE_ORDER
  return order.filter((key) => buckets.has(key)).map((key) => ({ key, items: buckets.get(key)! }))
}
