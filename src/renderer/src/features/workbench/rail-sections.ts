import { create } from 'zustand'

export const RAIL_SECTION_IDS = [
  'environment',
  'stats',
  'context',
  'usage',
  'connectors',
  'progress',
  'outputs',
  'changes',
  'backgroundTasks',
  'extensions'
] as const

export type RailSectionId = (typeof RAIL_SECTION_IDS)[number]

const COLLAPSED_BY_DEFAULT: readonly RailSectionId[] = ['connectors', 'context', 'usage', 'backgroundTasks']
const MAX_REMEMBERED_SESSIONS = 100
const STORAGE_KEY = 'inkstone.v3.rail.sections'

export interface RailFolds {
  collapsed: RailSectionId[]
  expanded: RailSectionId[]
}

export interface RailSectionsState {
  order: RailSectionId[]
  hidden: RailSectionId[]
  foldsBySession: Record<string, RailFolds>
}

export function isRailSectionId(value: unknown): value is RailSectionId {
  return typeof value === 'string' && (RAIL_SECTION_IDS as readonly string[]).includes(value)
}

export function canHideRailSection(id: RailSectionId): boolean {
  return id !== 'environment'
}

function uniqueIds(value: unknown): RailSectionId[] {
  if (!Array.isArray(value)) return []
  const out: RailSectionId[] = []
  for (const item of value) if (isRailSectionId(item) && !out.includes(item)) out.push(item)
  return out
}

export function resolveRailOrder(saved: readonly RailSectionId[]): RailSectionId[] {
  const known = uniqueIds(saved)
  if (known.length === 0) return [...RAIL_SECTION_IDS]
  const out = [...known]
  RAIL_SECTION_IDS.forEach((id, index) => {
    if (out.includes(id)) return
    const anchor = RAIL_SECTION_IDS.slice(index + 1).find((next) => out.includes(next))
    if (anchor) out.splice(out.indexOf(anchor), 0, id)
    else out.push(id)
  })
  return out
}

export function moveRailSection(
  order: readonly RailSectionId[],
  id: RailSectionId,
  target: RailSectionId,
  place: 'before' | 'after'
): RailSectionId[] {
  if (id === target) return [...order]
  const rest = order.filter((item) => item !== id)
  const at = rest.indexOf(target)
  if (at < 0) return [...order]
  rest.splice(place === 'before' ? at : at + 1, 0, id)
  return rest
}

export function isRailSectionOpen(state: RailSectionsState, session: string, id: RailSectionId): boolean {
  const folds = state.foldsBySession[session]
  if (COLLAPSED_BY_DEFAULT.includes(id)) return folds?.expanded.includes(id) === true
  return folds?.collapsed.includes(id) !== true
}

export function isRailSectionHidden(state: Pick<RailSectionsState, 'hidden'>, id: RailSectionId): boolean {
  return canHideRailSection(id) && state.hidden.includes(id)
}

export function railSectionsAreDefault(state: Pick<RailSectionsState, 'order' | 'hidden'>): boolean {
  if (state.hidden.some((id) => isRailSectionId(id) && canHideRailSection(id))) return false
  const order = resolveRailOrder(state.order)
  return order.every((id, index) => RAIL_SECTION_IDS[index] === id)
}

function toggled(list: readonly RailSectionId[], id: RailSectionId, include: boolean): RailSectionId[] {
  const rest = list.filter((item) => item !== id)
  return include ? [...rest, id] : rest
}

export function withRailSectionOpen(
  state: RailSectionsState,
  session: string,
  id: RailSectionId,
  open: boolean
): Record<string, RailFolds> {
  const current = state.foldsBySession[session] ?? { collapsed: [], expanded: [] }
  const next: RailFolds = COLLAPSED_BY_DEFAULT.includes(id)
    ? { ...current, expanded: toggled(current.expanded, id, open) }
    : { ...current, collapsed: toggled(current.collapsed, id, !open) }
  const { [session]: _previous, ...others } = state.foldsBySession
  const empty = next.collapsed.length === 0 && next.expanded.length === 0
  const merged: Record<string, RailFolds> = empty ? others : { ...others, [session]: next }
  const keys = Object.keys(merged)
  if (keys.length <= MAX_REMEMBERED_SESSIONS) return merged
  return Object.fromEntries(keys.slice(keys.length - MAX_REMEMBERED_SESSIONS).map((key) => [key, merged[key]]))
}

function sanitizeFolds(value: unknown): Record<string, RailFolds> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, RailFolds> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue
    const folds = raw as Record<string, unknown>
    const collapsed = uniqueIds(folds.collapsed)
    const expanded = uniqueIds(folds.expanded)
    if (collapsed.length === 0 && expanded.length === 0) continue
    out[key] = { collapsed, expanded }
  }
  const keys = Object.keys(out)
  return keys.length <= MAX_REMEMBERED_SESSIONS
    ? out
    : Object.fromEntries(keys.slice(keys.length - MAX_REMEMBERED_SESSIONS).map((key) => [key, out[key]]))
}

export function parseRailSections(raw: string | null): RailSectionsState {
  try {
    const value = JSON.parse(raw ?? 'null') as Record<string, unknown> | null
    if (!value || typeof value !== 'object') return { order: [], hidden: [], foldsBySession: {} }
    return {
      order: uniqueIds(value.order),
      hidden: uniqueIds(value.hidden).filter(canHideRailSection),
      foldsBySession: sanitizeFolds(value.foldsBySession)
    }
  } catch {
    return { order: [], hidden: [], foldsBySession: {} }
  }
}

function readStored(): RailSectionsState {
  if (typeof localStorage === 'undefined') return { order: [], hidden: [], foldsBySession: {} }
  try {
    return parseRailSections(localStorage.getItem(STORAGE_KEY))
  } catch {
    return { order: [], hidden: [], foldsBySession: {} }
  }
}

function writeStored(state: RailSectionsState): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ order: state.order, hidden: state.hidden, foldsBySession: state.foldsBySession })
    )
  } catch {
  }
}

interface RailSectionsStore extends RailSectionsState {
  setOpen: (session: string, id: RailSectionId, open: boolean) => void
  setHidden: (id: RailSectionId, hidden: boolean) => void
  setOrder: (order: RailSectionId[]) => void
  reset: () => void
}

export const useRailSections = create<RailSectionsStore>((set, get) => {
  const commit = (patch: Partial<RailSectionsState>): void => {
    set(patch)
    const { order, hidden, foldsBySession } = get()
    writeStored({ order, hidden, foldsBySession })
  }
  return {
    ...readStored(),
    setOpen: (session, id, open) => commit({ foldsBySession: withRailSectionOpen(get(), session, id, open) }),
    setHidden: (id, hidden) => {
      if (!canHideRailSection(id)) return
      commit({ hidden: toggled(get().hidden, id, hidden) })
    },
    setOrder: (order) => commit({ order: resolveRailOrder(order) }),
    reset: () => commit({ order: [], hidden: [] })
  }
})
