import { create } from 'zustand'
import { WORKBENCH_TABS, type WorkbenchTabId } from '../features/workbench/types'

export type PanelToolKind = Exclude<WorkbenchTabId, 'preview'>
export type PrDetailTab = 'summary' | 'timeline' | 'code'
export type PrSurfaceState = 'open' | 'draft' | 'merged' | 'closed'

export type RightPanelSurface =
  | { id: PanelToolKind; kind: PanelToolKind }
  | { id: `file:${string}`; kind: 'file'; path: string }
  | { id: `pr:${number}`; kind: 'pullRequest'; number: number; title?: string; state?: PrSurfaceState; tab?: PrDetailTab }
  | { id: `subagent:${string}`; kind: 'subagent'; runId: string }

export type PanelDockSide = 'left' | 'right' | 'bottom'
export type PanelEdgeDock = Exclude<PanelDockSide, 'right'>

export interface RightPanelGroup {
  active: string | null
  surfaces: RightPanelSurface[]
  size: number
  side?: PanelEdgeDock
}

export interface RightPanelEntry {
  open: boolean
  active: string | null
  surfaces: RightPanelSurface[]
  maximized: boolean
  groups?: RightPanelGroup[]
  focus?: number
}

export interface RightPanelSnapshot {
  version: 1
  width: number
  byKey: Record<string, RightPanelEntry>
  order: string[]
  dockLeft?: number
  dockBottom?: number
}

export const RIGHT_PANEL_STORAGE_KEY = 'inkstone.v3.rightPanel'
export const RIGHT_PANEL_VERSION = 1
export const RIGHT_PANEL_MAX_SESSIONS = 100
export const HOME_PANEL_KEY = 'home'
export const SESSION_PANEL_PREFIX = 's:'
export const PANEL_WIDTH_MIN = 360
export const PANEL_WIDTH_DEFAULT = 720
export const PANEL_WIDTH_MAX_FRACTION = 0.7
export const PANEL_GROUPS_MAX = 3
export const PANEL_GROUP_MIN_WIDTH = 280
export const DOCK_LEFT_DEFAULT = 360
export const DOCK_LEFT_MIN = 260
export const DOCK_BOTTOM_DEFAULT = 280
export const DOCK_BOTTOM_MIN = 140
export const DOCK_SIZE_MAX = 4000
export const PANEL_TOOL_KINDS: readonly PanelToolKind[] = WORKBENCH_TABS.filter(
  (tab): tab is Exclude<WorkbenchTabId, 'preview'> => tab !== 'preview'
)

const PR_TABS: readonly PrDetailTab[] = ['summary', 'timeline', 'code']
const PR_STATES: readonly PrSurfaceState[] = ['open', 'draft', 'merged', 'closed']
const RUN_ID = /^[\w.-]{1,96}$/
const MAX_PR_NUMBER = 9_999_999

export const EMPTY_PANEL: RightPanelEntry = Object.freeze({ open: false, active: null, surfaces: [], maximized: false, groups: [], focus: 0 }) as RightPanelEntry

export function panelKeyFor(sessionId: string | null | undefined): string {
  const id = typeof sessionId === 'string' ? sessionId.trim() : ''
  return id ? `${SESSION_PANEL_PREFIX}${id}` : HOME_PANEL_KEY
}

export function isPanelToolKind(value: unknown): value is PanelToolKind {
  return typeof value === 'string' && (PANEL_TOOL_KINDS as readonly string[]).includes(value)
}

export function toolSurface(kind: PanelToolKind | 'preview'): RightPanelSurface {
  const tool: PanelToolKind = kind === 'preview' ? 'files' : kind
  return { id: tool, kind: tool }
}

export function fileSurface(path: string): RightPanelSurface {
  return { id: `file:${path}`, kind: 'file', path }
}

export function pullRequestSurface(number: number, meta: { title?: string; state?: PrSurfaceState; tab?: PrDetailTab } = {}): RightPanelSurface {
  return {
    id: `pr:${number}`,
    kind: 'pullRequest',
    number,
    ...(meta.title ? { title: meta.title } : {}),
    ...(meta.state ? { state: meta.state } : {}),
    ...(meta.tab ? { tab: meta.tab } : {})
  }
}

export function subagentSurface(runId: string): RightPanelSurface {
  return { id: `subagent:${runId}`, kind: 'subagent', runId }
}

export function panelMaxWidth(room: number): number {
  return Number.isFinite(room) ? Math.max(PANEL_WIDTH_MIN, Math.floor(room)) : Number.POSITIVE_INFINITY
}

export function panelRoom(viewportWidth: number, rowWidth: number, siblingMin: number): number {
  return panelMaxWidth(Math.min(viewportWidth * PANEL_WIDTH_MAX_FRACTION, rowWidth - siblingMin))
}

export function clampPanelWidth(value: number, room = Number.POSITIVE_INFINITY): number {
  const max = panelMaxWidth(room)
  if (!Number.isFinite(value)) return Math.min(PANEL_WIDTH_DEFAULT, max)
  return Math.round(Math.min(max, Math.max(PANEL_WIDTH_MIN, value)))
}

function sameSurface(a: RightPanelSurface, b: RightPanelSurface): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function panelGroups(entry: RightPanelEntry): RightPanelGroup[] {
  if (entry.groups) return entry.groups
  return entry.surfaces.length ? [{ active: entry.active, surfaces: entry.surfaces, size: 1 }] : []
}

export function groupSide(group: RightPanelGroup): PanelDockSide {
  return group.side ?? 'right'
}

export function rightGroupCount(groups: readonly RightPanelGroup[]): number {
  return groups.filter((group) => !group.side).length
}

export function dockGroupIndex(entry: RightPanelEntry, side: PanelEdgeDock): number {
  return panelGroups(entry).findIndex((group) => group.side === side)
}

function toRight(group: RightPanelGroup): RightPanelGroup {
  if (!group.side) return group
  const { side: _side, ...rest } = group
  return rest
}

const SIDE_RANK: Record<PanelDockSide, number> = { right: 0, left: 1, bottom: 2 }

export function panelFocus(entry: RightPanelEntry): number {
  const count = panelGroups(entry).length
  return Math.max(0, Math.min(count - 1, Math.trunc(entry.focus ?? 0)))
}

function groupIndexOf(groups: readonly RightPanelGroup[], id: string): number {
  return groups.findIndex((group) => group.surfaces.some((item) => item.id === id))
}

function neighborActive(surfaces: readonly RightPanelSurface[], active: string | null, gone: ReadonlySet<string>): string | null {
  if (active === null || !gone.has(active)) return active
  const index = surfaces.findIndex((item) => item.id === active)
  for (let step = 1; step < surfaces.length; step++) {
    const right = surfaces[index + step]
    const left = surfaces[index - step]
    if (right && !gone.has(right.id)) return right.id
    if (left && !gone.has(left.id)) return left.id
  }
  return null
}

function withGroups(entry: RightPanelEntry, groups: RightPanelGroup[], focus: number, open = entry.open): RightPanelEntry {
  let focusOrigin = -1
  groups.forEach((group, index) => {
    if (group.surfaces.length && index <= focus) focusOrigin = index
  })
  const merged: Array<{ group: RightPanelGroup; origins: number[] }> = []
  groups.forEach((group, index) => {
    if (!group.surfaces.length) return
    const same = group.side ? merged.find((item) => item.group.side === group.side) : undefined
    if (same) {
      same.group = { ...same.group, surfaces: [...same.group.surfaces, ...group.surfaces], active: index === focusOrigin ? group.active : same.group.active }
      same.origins.push(index)
    } else merged.push({ group, origins: [index] })
  })
  merged.sort((a, b) => SIDE_RANK[groupSide(a.group)] - SIDE_RANK[groupSide(b.group)])
  const kept: RightPanelGroup[] = []
  let nextFocus = 0
  merged.forEach(({ group, origins }) => {
    const active = group.surfaces.some((item) => item.id === group.active) ? group.active : group.surfaces[group.surfaces.length - 1].id
    if (origins.includes(focusOrigin)) nextFocus = kept.length
    kept.push(active === group.active ? group : { ...group, active })
  })
  if (!kept.length) return { ...entry, surfaces: [], active: null, open: false, maximized: false, groups: [], focus: 0 }
  const rights = rightGroupCount(kept)
  const total = kept.reduce((sum, group) => sum + (group.side ? 0 : group.size), 0)
  if (Math.abs(total - rights) > 1e-6 || kept.some((group) => group.side && group.size !== 1)) {
    const scale = total > 0 ? rights / total : 1
    kept.forEach((group, at) => {
      const size = group.side ? 1 : total > 0 ? group.size * scale : 1
      if (size !== group.size) kept[at] = { ...group, size }
    })
  }
  return {
    ...entry,
    open,
    groups: kept,
    focus: nextFocus,
    surfaces: kept.length === 1 ? kept[0].surfaces : kept.flatMap((group) => group.surfaces),
    active: kept[nextFocus].active
  }
}

function mapGroup(entry: RightPanelEntry, index: number, fn: (group: RightPanelGroup) => RightPanelGroup, focus = index, open = entry.open): RightPanelEntry {
  const groups = panelGroups(entry)
  const current = groups[index]
  if (!current) return entry
  const next = fn(current)
  if (next === current && focus === panelFocus(entry) && open === entry.open) return entry
  return withGroups(entry, groups.map((group, at) => (at === index ? next : group)), focus, open)
}

export function upsertSurface(entry: RightPanelEntry, surface: RightPanelSurface, activate = true): RightPanelEntry {
  const groups = panelGroups(entry)
  const at = groupIndexOf(groups, surface.id)
  if (at < 0) {
    if (!groups.length) return withGroups(entry, [{ active: surface.id, surfaces: [surface], size: 1 }], 0, true)
    const focus = panelFocus(entry)
    return mapGroup(entry, focus, (group) => ({ ...group, surfaces: [...group.surfaces, surface], active: activate ? surface.id : group.active ?? surface.id }), focus, true)
  }
  return mapGroup(
    entry,
    at,
    (group) => {
      const index = group.surfaces.findIndex((item) => item.id === surface.id)
      const current = group.surfaces[index]
      const merged: RightPanelSurface =
        current.kind === 'pullRequest' && surface.kind === 'pullRequest'
          ? pullRequestSurface(surface.number, { title: surface.title ?? current.title, state: surface.state ?? current.state, tab: surface.tab ?? current.tab })
          : surface
      const surfaces = sameSurface(current, merged) ? group.surfaces : group.surfaces.map((item, i) => (i === index ? merged : item))
      const active = activate ? surface.id : group.active ?? surface.id
      return surfaces === group.surfaces && active === group.active ? group : { ...group, surfaces, active }
    },
    activate ? at : panelFocus(entry),
    true
  )
}

export function activateSurface(entry: RightPanelEntry, id: string): RightPanelEntry {
  const at = groupIndexOf(panelGroups(entry), id)
  if (at < 0) return entry
  return mapGroup(entry, at, (group) => (group.active === id ? group : { ...group, active: id }), at, true)
}

export function updateSurface(entry: RightPanelEntry, surface: RightPanelSurface): RightPanelEntry {
  const groups = panelGroups(entry)
  const at = groupIndexOf(groups, surface.id)
  if (at < 0) return entry
  return mapGroup(entry, at, (group) => {
    const current = group.surfaces.find((item) => item.id === surface.id && item.kind === surface.kind)
    if (!current) return group
    const merged = { ...current, ...surface } as RightPanelSurface
    if (sameSurface(current, merged)) return group
    return { ...group, surfaces: group.surfaces.map((item) => (item === current ? merged : item)) }
  }, panelFocus(entry))
}

export function removeSurfaces(entry: RightPanelEntry, ids: ReadonlySet<string>): RightPanelEntry {
  if (!entry.surfaces.some((item) => ids.has(item.id))) return entry
  const groups = panelGroups(entry)
  const focus = panelFocus(entry)
  const next = groups.map((group) =>
    group.surfaces.some((item) => ids.has(item.id))
      ? { ...group, surfaces: group.surfaces.filter((item) => !ids.has(item.id)), active: neighborActive(group.surfaces, group.active, ids) }
      : group
  )
  const focusGone = !next[focus]?.surfaces.length
  return withGroups(entry, next, focusGone ? Math.max(0, focus - 1) : focus)
}

export function closeSurface(entry: RightPanelEntry, id: string): RightPanelEntry {
  return removeSurfaces(entry, new Set([id]))
}

export function closeOtherSurfaces(entry: RightPanelEntry, id: string): RightPanelEntry {
  const groups = panelGroups(entry)
  const at = groupIndexOf(groups, id)
  if (at < 0) return entry
  const gone = new Set(groups[at].surfaces.filter((item) => item.id !== id).map((item) => item.id))
  return activateSurface(removeSurfaces(entry, gone), id)
}

export function closeSurfacesToRight(entry: RightPanelEntry, id: string): RightPanelEntry {
  const groups = panelGroups(entry)
  const at = groupIndexOf(groups, id)
  if (at < 0) return entry
  const surfaces = groups[at].surfaces
  const index = surfaces.findIndex((item) => item.id === id)
  const gone = new Set<string>(surfaces.slice(index + 1).map((item) => item.id))
  const next = removeSurfaces(entry, gone)
  return gone.has(groups[at].active ?? '') ? activateSurface(next, id) : next
}

export function closeAllSurfaces(entry: RightPanelEntry): RightPanelEntry {
  return removeSurfaces(entry, new Set(entry.surfaces.map((item) => item.id)))
}

export function closeGroup(entry: RightPanelEntry, index: number): RightPanelEntry {
  const group = panelGroups(entry)[index]
  return group ? removeSurfaces(entry, new Set(group.surfaces.map((item) => item.id))) : entry
}

export function moveSurface(entry: RightPanelEntry, id: string, toIndex: number): RightPanelEntry {
  const groups = panelGroups(entry)
  const at = groupIndexOf(groups, id)
  if (at < 0) return entry
  return mapGroup(entry, at, (group) => {
    const from = group.surfaces.findIndex((item) => item.id === id)
    const to = Math.max(0, Math.min(group.surfaces.length - 1, Math.trunc(toIndex)))
    if (to === from) return group
    const surfaces = group.surfaces.slice()
    const [moved] = surfaces.splice(from, 1)
    surfaces.splice(to, 0, moved)
    return { ...group, surfaces }
  }, panelFocus(entry))
}

function evenGroups(groups: readonly RightPanelGroup[]): RightPanelGroup[] {
  return groups.map((group) => (group.size === 1 ? group : { ...group, size: 1 }))
}

export function moveSurfaceToGroup(entry: RightPanelEntry, id: string, target: number, toIndex = Number.POSITIVE_INFINITY): RightPanelEntry {
  const groups = panelGroups(entry)
  const from = groupIndexOf(groups, id)
  if (from < 0) return entry
  const surface = groups[from].surfaces.find((item) => item.id === id)!
  const creating = target < 0 || target >= groups.length
  if (creating && groups[from].surfaces.length < 2) {
    const rest = groups.filter((_, at) => at !== from)
    const insertAt = target < 0 ? 0 : rightGroupCount(rest)
    if (!groups[from].side && insertAt === from) return entry
    if (groups[from].side && rightGroupCount(rest) >= PANEL_GROUPS_MAX) return entry
    rest.splice(insertAt, 0, toRight(groups[from]))
    return withGroups(entry, groups[from].side ? evenGroups(rest) : rest, insertAt, true)
  }
  if (creating && rightGroupCount(groups) >= PANEL_GROUPS_MAX) return entry
  if (!creating && target === from) return moveSurface(entry, id, toIndex)
  const gone = new Set([id])
  const next = groups.map((group, at) =>
    at === from ? { ...group, surfaces: group.surfaces.filter((item) => item.id !== id), active: neighborActive(group.surfaces, group.active, gone) } : group
  )
  if (creating) {
    const insertAt = target < 0 ? 0 : rightGroupCount(next)
    next.splice(insertAt, 0, { active: id, surfaces: [surface], size: 1 })
    return withGroups(entry, evenGroups(next), insertAt, true)
  }
  const dest = next[target]
  const surfaces = dest.surfaces.slice()
  surfaces.splice(Math.max(0, Math.min(surfaces.length, Math.trunc(toIndex))), 0, surface)
  next[target] = { ...dest, surfaces, active: id }
  const emptied = !next[from].surfaces.length
  return withGroups(entry, next, emptied && from < target ? target - 1 : target, true)
}

export function moveSurfaceToDock(entry: RightPanelEntry, id: string, side: PanelEdgeDock): RightPanelEntry {
  const groups = panelGroups(entry)
  const from = groupIndexOf(groups, id)
  if (from < 0 || groups[from].side === side) return entry
  const existing = groups.findIndex((group) => group.side === side)
  if (existing >= 0) return moveSurfaceToGroup(entry, id, existing)
  if (groups[from].surfaces.length < 2) {
    return withGroups(entry, evenGroups(groups.map((group, at) => (at === from ? { ...group, side, size: 1 } : group))), from, true)
  }
  const gone = new Set([id])
  const surface = groups[from].surfaces.find((item) => item.id === id)!
  const next = groups.map((group, at) =>
    at === from ? { ...group, surfaces: group.surfaces.filter((item) => item.id !== id), active: neighborActive(group.surfaces, group.active, gone) } : group
  )
  next.push({ active: id, surfaces: [surface], size: 1, side })
  return withGroups(entry, next, next.length - 1, true)
}

export function moveSurfaceToRight(entry: RightPanelEntry, id: string): RightPanelEntry {
  const groups = panelGroups(entry)
  const from = groupIndexOf(groups, id)
  if (from < 0 || !groups[from].side) return entry
  const rights = rightGroupCount(groups)
  return moveSurfaceToGroup(entry, id, rights < PANEL_GROUPS_MAX ? groups.length : rights - 1)
}

export function canMoveSurfaceToDock(entry: RightPanelEntry, id: string, side: PanelEdgeDock): boolean {
  return moveSurfaceToDock(entry, id, side) !== entry
}

export function splitSurface(entry: RightPanelEntry, id: string): RightPanelEntry {
  const groups = panelGroups(entry)
  const from = groupIndexOf(groups, id)
  if (from < 0 || groups[from].side) return entry
  if (rightGroupCount(groups) < PANEL_GROUPS_MAX && groups[from].surfaces.length > 1) {
    const gone = new Set([id])
    const surface = groups[from].surfaces.find((item) => item.id === id)!
    const next = groups.map((group, at) =>
      at === from ? { ...group, surfaces: group.surfaces.filter((item) => item.id !== id), active: neighborActive(group.surfaces, group.active, gone) } : group
    )
    next.splice(from + 1, 0, { active: id, surfaces: [surface], size: 1 })
    return withGroups(entry, evenGroups(next), from + 1, true)
  }
  if (from + 1 < rightGroupCount(groups)) return moveSurfaceToGroup(entry, id, from + 1)
  return entry
}

export function canSplitSurface(entry: RightPanelEntry, id: string): boolean {
  return splitSurface(entry, id) !== entry
}

export function focusGroup(entry: RightPanelEntry, index: number): RightPanelEntry {
  const groups = panelGroups(entry)
  if (!groups[index] || (index === panelFocus(entry) && entry.groups)) return entry
  return withGroups(entry, groups, index)
}

export function resizeGroups(entry: RightPanelEntry, index: number, leftShare: number): RightPanelEntry {
  const groups = panelGroups(entry)
  const left = groups[index]
  const right = groups[index + 1]
  if (!left || !right || !Number.isFinite(leftShare)) return entry
  const total = left.size + right.size
  const share = Math.max(0.05, Math.min(0.95, leftShare))
  const nextLeft = total * share
  if (Math.abs(nextLeft - left.size) < 1e-4) return entry
  const next = groups.slice()
  next[index] = { ...left, size: nextLeft }
  next[index + 1] = { ...right, size: total - nextLeft }
  return withGroups(entry, next, panelFocus(entry))
}

export function stepSurface(entry: RightPanelEntry, delta: number): RightPanelEntry {
  const group = panelGroups(entry)[panelFocus(entry)]
  if (!group?.surfaces.length) return entry
  const index = Math.max(0, group.surfaces.findIndex((item) => item.id === group.active))
  const next = group.surfaces[(index + delta + group.surfaces.length * 4) % group.surfaces.length]
  return activateSurface(entry, next.id)
}

export function replaceSurface(entry: RightPanelEntry, fromId: string, surface: RightPanelSurface): RightPanelEntry {
  const groups = panelGroups(entry)
  const at = groupIndexOf(groups, fromId)
  if (at < 0 || groupIndexOf(groups, surface.id) >= 0) return upsertSurface(entry, surface)
  return mapGroup(
    entry,
    at,
    (group) => ({ ...group, surfaces: group.surfaces.map((item) => (item.id === fromId ? surface : item)), active: group.active === fromId ? surface.id : group.active }),
    panelFocus(entry),
    true
  )
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function sanitizeSurface(value: unknown): RightPanelSurface | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const kind = text(raw.kind)
  if (kind === 'preview') return toolSurface('files')
  if (kind === 'overview') return null
  if (isPanelToolKind(kind)) return toolSurface(kind)
  if (kind === 'file') {
    const path = text(raw.path)
    return path ? fileSurface(path) : null
  }
  if (kind === 'pullRequest') {
    const number = raw.number
    if (typeof number !== 'number' || !Number.isInteger(number) || number < 1 || number > MAX_PR_NUMBER) return null
    const tab = PR_TABS.includes(raw.tab as PrDetailTab) ? (raw.tab as PrDetailTab) : undefined
    const state = PR_STATES.includes(raw.state as PrSurfaceState) ? (raw.state as PrSurfaceState) : undefined
    return pullRequestSurface(number, { title: text(raw.title).slice(0, 300) || undefined, state, tab })
  }
  if (kind === 'subagent') {
    const runId = text(raw.runId)
    return RUN_ID.test(runId) ? subagentSurface(runId) : null
  }
  return null
}

function sanitizeGroupList(raw: Record<string, unknown>): RightPanelGroup[] {
  const seen = new Set<string>()
  const surfacesOf = (list: unknown): RightPanelSurface[] => {
    const surfaces: RightPanelSurface[] = []
    if (!Array.isArray(list)) return surfaces
    for (const item of list) {
      const surface = sanitizeSurface(item)
      if (surface && !seen.has(surface.id)) {
        seen.add(surface.id)
        surfaces.push(surface)
      }
    }
    return surfaces
  }
  const rawGroups = Array.isArray(raw.groups) ? raw.groups : null
  if (!rawGroups) return [{ active: typeof raw.active === 'string' ? raw.active : null, surfaces: surfacesOf(raw.surfaces), size: 1 }]
  let rights = 0
  return rawGroups.flatMap((item) => {
    const group = item && typeof item === 'object' && !Array.isArray(item) ? (item as Record<string, unknown>) : {}
    const side = group.side === 'left' || group.side === 'bottom' ? group.side : undefined
    if (!side && ++rights > PANEL_GROUPS_MAX) return []
    const size = typeof group.size === 'number' && Number.isFinite(group.size) && group.size > 0 ? group.size : 1
    return [{ active: typeof group.active === 'string' ? group.active : null, surfaces: surfacesOf(group.surfaces), size, ...(side ? { side } : {}) }]
  })
}

export function sanitizePanelEntry(value: unknown): RightPanelEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (!Array.isArray(raw.surfaces) && !Array.isArray(raw.groups)) return null
  const focus = typeof raw.focus === 'number' && Number.isInteger(raw.focus) ? raw.focus : 0
  const open = raw.open === true
  const entry = withGroups({ ...EMPTY_PANEL, open, maximized: raw.maximized === true && open }, sanitizeGroupList(raw), focus, open)
  return entry.surfaces.length ? entry : null
}

export function emptyRightPanelSnapshot(): RightPanelSnapshot {
  return { version: RIGHT_PANEL_VERSION, width: PANEL_WIDTH_DEFAULT, byKey: {}, order: [], dockLeft: DOCK_LEFT_DEFAULT, dockBottom: DOCK_BOTTOM_DEFAULT }
}

export function clampDockSize(side: PanelEdgeDock, value: unknown): number {
  const min = side === 'left' ? DOCK_LEFT_MIN : DOCK_BOTTOM_MIN
  const fallback = side === 'left' ? DOCK_LEFT_DEFAULT : DOCK_BOTTOM_DEFAULT
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.round(Math.min(DOCK_SIZE_MAX, Math.max(min, value)))
}

export function capPanelSessions(snapshot: RightPanelSnapshot, limit = RIGHT_PANEL_MAX_SESSIONS): RightPanelSnapshot {
  const known = new Set(snapshot.order)
  const keys = [...snapshot.order.filter((key) => key in snapshot.byKey), ...Object.keys(snapshot.byKey).filter((key) => !known.has(key))]
  const kept = keys.slice(Math.max(0, keys.length - limit))
  const byKey: Record<string, RightPanelEntry> = {}
  for (const key of kept) byKey[key] = snapshot.byKey[key]
  return { ...snapshot, byKey, order: kept }
}

export function sanitizeRightPanel(value: unknown): RightPanelSnapshot {
  const snapshot = emptyRightPanelSnapshot()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return snapshot
  const raw = value as Record<string, unknown>
  if (raw.version !== RIGHT_PANEL_VERSION) return snapshot
  snapshot.width = typeof raw.width === 'number' && raw.width >= PANEL_WIDTH_MIN ? clampPanelWidth(raw.width) : PANEL_WIDTH_DEFAULT
  snapshot.dockLeft = clampDockSize('left', raw.dockLeft)
  snapshot.dockBottom = clampDockSize('bottom', raw.dockBottom)
  const byKey = raw.byKey && typeof raw.byKey === 'object' && !Array.isArray(raw.byKey) ? (raw.byKey as Record<string, unknown>) : {}
  const order = Array.isArray(raw.order) ? raw.order.filter((key): key is string => typeof key === 'string' && key.length > 0) : []
  for (const key of [...new Set([...order, ...Object.keys(byKey)])]) {
    if (!Object.prototype.hasOwnProperty.call(byKey, key)) continue
    const entry = sanitizePanelEntry(byKey[key])
    if (!entry) continue
    snapshot.byKey[key] = entry
    snapshot.order.push(key)
  }
  return capPanelSessions(snapshot)
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function readRightPanel(store: Pick<Storage, 'getItem'> | null = storage()): RightPanelSnapshot {
  if (!store) return emptyRightPanelSnapshot()
  try {
    return sanitizeRightPanel(JSON.parse(store.getItem(RIGHT_PANEL_STORAGE_KEY) ?? 'null'))
  } catch {
    return emptyRightPanelSnapshot()
  }
}

export function writeRightPanel(snapshot: RightPanelSnapshot, store: Pick<Storage, 'setItem'> | null = storage()): void {
  if (!store) return
  try {
    store.setItem(RIGHT_PANEL_STORAGE_KEY, JSON.stringify(capPanelSessions(snapshot)))
  } catch {
  }
}

export interface RightPanelState {
  key: string
  byKey: Record<string, RightPanelEntry>
  order: string[]
  width: number
  dockLeft: number
  dockBottom: number
  load: (sessionId: string | null | undefined) => void
  open: (surface: RightPanelSurface) => void
  updateSurface: (key: string, surface: RightPanelSurface) => void
  activate: (id: string) => void
  close: (id: string) => void
  closeOthers: (id: string) => void
  closeRight: (id: string) => void
  closeAll: () => void
  move: (id: string, toIndex: number) => void
  moveToGroup: (id: string, group: number, toIndex?: number) => void
  split: (id: string) => void
  moveToDock: (id: string, side: PanelEdgeDock) => void
  moveToRight: (id: string) => void
  setDockSize: (side: PanelEdgeDock, size: number) => void
  closeGroup: (index: number) => void
  focusGroup: (index: number) => void
  resizeGroups: (index: number, leftShare: number) => void
  step: (delta: number) => void
  replace: (fromId: string, surface: RightPanelSurface) => void
  setOpen: (open: boolean) => void
  toggle: () => void
  setMaximized: (on: boolean) => void
  setWidth: (width: number) => void
  drop: (ids: readonly string[]) => void
}

function entryKeyed(state: Pick<RightPanelState, 'byKey' | 'order'>, key: string, entry: RightPanelEntry): Pick<RightPanelState, 'byKey' | 'order'> {
  if (state.byKey[key] === entry) return state
  const order = [...state.order.filter((item) => item !== key), key]
  if (!entry.surfaces.length && !entry.open) {
    const { [key]: _gone, ...rest } = state.byKey
    return { byKey: rest, order: order.filter((item) => item !== key) }
  }
  const capped = capPanelSessions({ version: RIGHT_PANEL_VERSION, width: PANEL_WIDTH_DEFAULT, byKey: { ...state.byKey, [key]: entry }, order })
  return { byKey: capped.byKey, order: capped.order }
}

const initial = readRightPanel()

export const useRightPanel = create<RightPanelState>((set, get) => {
  const update = (fn: (entry: RightPanelEntry) => RightPanelEntry): void => {
    const state = get()
    const current = state.byKey[state.key] ?? EMPTY_PANEL
    const next = fn(current)
    if (next === current) return
    set(entryKeyed(state, state.key, next))
  }
  return {
    key: HOME_PANEL_KEY,
    byKey: initial.byKey,
    order: initial.order,
    width: initial.width,
    dockLeft: initial.dockLeft ?? DOCK_LEFT_DEFAULT,
    dockBottom: initial.dockBottom ?? DOCK_BOTTOM_DEFAULT,
    load: (sessionId) => {
      const key = panelKeyFor(sessionId)
      const state = get()
      if (state.key === key) return
      const home = state.byKey[HOME_PANEL_KEY]
      if (!state.byKey[key] && state.key === HOME_PANEL_KEY && key !== HOME_PANEL_KEY && home?.surfaces.length) {
        set({ key, ...entryKeyed(entryKeyed(state, key, home), HOME_PANEL_KEY, { ...home, open: false, maximized: false }) })
        return
      }
      set({ key })
    },
    open: (surface) => update((entry) => upsertSurface(entry, surface)),
    updateSurface: (key, surface) => {
      const state = get()
      const current = state.byKey[key]
      if (!current) return
      const next = updateSurface(current, surface)
      if (next !== current) set({ byKey: { ...state.byKey, [key]: next } })
    },
    activate: (id) => update((entry) => activateSurface(entry, id)),
    close: (id) => update((entry) => closeSurface(entry, id)),
    closeOthers: (id) => update((entry) => closeOtherSurfaces(entry, id)),
    closeRight: (id) => update((entry) => closeSurfacesToRight(entry, id)),
    closeAll: () => update(closeAllSurfaces),
    move: (id, toIndex) => update((entry) => moveSurface(entry, id, toIndex)),
    moveToGroup: (id, group, toIndex) => update((entry) => moveSurfaceToGroup(entry, id, group, toIndex)),
    split: (id) => update((entry) => splitSurface(entry, id)),
    moveToDock: (id, side) => update((entry) => moveSurfaceToDock(entry, id, side)),
    moveToRight: (id) => update((entry) => moveSurfaceToRight(entry, id)),
    setDockSize: (side, size) => {
      const next = clampDockSize(side, size)
      if (side === 'left' ? next !== get().dockLeft : next !== get().dockBottom) set(side === 'left' ? { dockLeft: next } : { dockBottom: next })
    },
    closeGroup: (index) => update((entry) => closeGroup(entry, index)),
    focusGroup: (index) => update((entry) => focusGroup(entry, index)),
    resizeGroups: (index, leftShare) => update((entry) => resizeGroups(entry, index, leftShare)),
    step: (delta) => update((entry) => stepSurface(entry, delta)),
    replace: (fromId, surface) => update((entry) => replaceSurface(entry, fromId, surface)),
    setOpen: (open) =>
      update((entry) => (entry.open === open ? entry : { ...entry, open, maximized: open ? entry.maximized : false })),
    toggle: () => update((entry) => ({ ...entry, open: !entry.open, maximized: entry.open ? false : entry.maximized })),
    setMaximized: (on) => update((entry) => (entry.maximized === on || (on && !entry.open) ? entry : { ...entry, maximized: on })),
    setWidth: (width) => {
      const next = clampPanelWidth(width)
      if (next !== get().width) set({ width: next })
    },
    drop: (ids) => {
      if (!ids.length) return
      const gone = new Set(ids)
      const state = get()
      let partial: Pick<RightPanelState, 'byKey' | 'order'> = state
      for (const key of Object.keys(state.byKey)) partial = entryKeyed(partial, key, removeSurfaces(partial.byKey[key], gone))
      if (partial !== state) set(partial)
    }
  }
})

export function currentPanelEntry(state: Pick<RightPanelState, 'key' | 'byKey'> = useRightPanel.getState()): RightPanelEntry {
  return state.byKey[state.key] ?? EMPTY_PANEL
}

export function useRightPanelEntry(): RightPanelEntry {
  return useRightPanel((state) => state.byKey[state.key] ?? EMPTY_PANEL)
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
useRightPanel.subscribe((state, previous) => {
  if (state.byKey === previous.byKey && state.order === previous.order && state.width === previous.width && state.dockLeft === previous.dockLeft && state.dockBottom === previous.dockBottom) return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    const latest = useRightPanel.getState()
    writeRightPanel({ version: RIGHT_PANEL_VERSION, width: latest.width, byKey: latest.byKey, order: latest.order, dockLeft: latest.dockLeft, dockBottom: latest.dockBottom })
  }, 150)
})
