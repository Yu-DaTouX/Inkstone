export type RailGroupBy = 'project' | 'state' | 'date' | 'none'
export type RailSortBy = 'recent' | 'name' | 'created'

export type RailShow = 'active' | 'archived'

export interface RailView {
  group: RailGroupBy
  sort: RailSortBy
  show: RailShow
}

export const DEFAULT_RAIL_VIEW: RailView = { group: 'project', sort: 'recent', show: 'active' }

const GROUPS: readonly RailGroupBy[] = ['project', 'state', 'date', 'none']
const SORTS: readonly RailSortBy[] = ['recent', 'name', 'created']

export function normalizeRailView(raw: unknown): RailView {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof RailView, unknown>>
  return {
    group: GROUPS.includes(o.group as RailGroupBy) ? (o.group as RailGroupBy) : DEFAULT_RAIL_VIEW.group,
    sort: SORTS.includes(o.sort as RailSortBy) ? (o.sort as RailSortBy) : DEFAULT_RAIL_VIEW.sort,
    show: o.show === 'archived' ? 'archived' : 'active'
  }
}

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

export function compareBy(sort: RailSortBy): (a: RailViewItem, b: RailViewItem) => number {
  if (sort === 'name') {
    return (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }) || activityOf(b) - activityOf(a)
  }
  if (sort === 'created') return (a, b) => b.createdAt - a.createdAt || activityOf(b) - activityOf(a)
  return (a, b) => activityOf(b) - activityOf(a)
}

function startOfDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

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
