import { create } from 'zustand'
import { WORKBENCH_TABS, type WorkbenchTabId } from '../features/workbench/types'

export type PanelToolKind = Exclude<WorkbenchTabId, 'preview'> | 'overview'
export type PrDetailTab = 'summary' | 'timeline' | 'code'
export type PrSurfaceState = 'open' | 'draft' | 'merged' | 'closed'

export type RightPanelSurface =
  | { id: PanelToolKind; kind: PanelToolKind }
  | { id: `file:${string}`; kind: 'file'; path: string }
  | { id: `pr:${number}`; kind: 'pullRequest'; number: number; title?: string; state?: PrSurfaceState; tab?: PrDetailTab }
  | { id: `subagent:${string}`; kind: 'subagent'; runId: string }

export interface RightPanelEntry {
  open: boolean
  active: string | null
  surfaces: RightPanelSurface[]
  maximized: boolean
}

export interface RightPanelSnapshot {
  version: 1
  width: number
  byKey: Record<string, RightPanelEntry>
  order: string[]
}

export const RIGHT_PANEL_STORAGE_KEY = 'inkstone.v3.rightPanel'
export const RIGHT_PANEL_VERSION = 1
export const RIGHT_PANEL_MAX_SESSIONS = 100
export const HOME_PANEL_KEY = 'home'
export const SESSION_PANEL_PREFIX = 's:'
export const PANEL_WIDTH_MIN = 360
export const PANEL_WIDTH_DEFAULT = 720
export const PANEL_WIDTH_MAX_FRACTION = 0.7
export const PANEL_WIDTH_STEP = 16
export const PANEL_TOOL_KINDS: readonly PanelToolKind[] = [
  ...WORKBENCH_TABS.filter((tab): tab is Exclude<WorkbenchTabId, 'preview'> => tab !== 'preview'),
  'overview'
]

const PR_TABS: readonly PrDetailTab[] = ['summary', 'timeline', 'code']
const PR_STATES: readonly PrSurfaceState[] = ['open', 'draft', 'merged', 'closed']
const RUN_ID = /^[\w.-]{1,96}$/
const MAX_PR_NUMBER = 9_999_999

export const EMPTY_PANEL: RightPanelEntry = Object.freeze({ open: false, active: null, surfaces: [], maximized: false }) as RightPanelEntry

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

export function upsertSurface(entry: RightPanelEntry, surface: RightPanelSurface, activate = true): RightPanelEntry {
  const index = entry.surfaces.findIndex((item) => item.id === surface.id)
  let surfaces = entry.surfaces
  if (index < 0) surfaces = [...entry.surfaces, surface]
  else {
    const current = entry.surfaces[index]
    const merged: RightPanelSurface =
      current.kind === 'pullRequest' && surface.kind === 'pullRequest'
        ? pullRequestSurface(surface.number, { title: surface.title ?? current.title, state: surface.state ?? current.state, tab: surface.tab ?? current.tab })
        : surface
    if (!sameSurface(current, merged)) surfaces = entry.surfaces.map((item, at) => (at === index ? merged : item))
  }
  const active = activate ? surface.id : entry.active ?? surface.id
  if (surfaces === entry.surfaces && active === entry.active && entry.open) return entry
  return { ...entry, open: true, surfaces, active }
}

export function activateSurface(entry: RightPanelEntry, id: string): RightPanelEntry {
  if (!entry.surfaces.some((item) => item.id === id)) return entry
  if (entry.active === id && entry.open) return entry
  return { ...entry, active: id, open: true }
}

export function removeSurfaces(entry: RightPanelEntry, ids: ReadonlySet<string>): RightPanelEntry {
  if (!entry.surfaces.some((item) => ids.has(item.id))) return entry
  const kept = entry.surfaces.filter((item) => !ids.has(item.id))
  let active = entry.active
  if (active !== null && ids.has(active)) {
    const index = entry.surfaces.findIndex((item) => item.id === active)
    let next: string | null = null
    for (let step = 1; step < entry.surfaces.length && next === null; step++) {
      const right = entry.surfaces[index + step]
      const left = entry.surfaces[index - step]
      if (right && !ids.has(right.id)) next = right.id
      else if (left && !ids.has(left.id)) next = left.id
    }
    active = next
  }
  if (!kept.length) return { ...entry, surfaces: [], active: null, open: false, maximized: false }
  return { ...entry, surfaces: kept, active: active ?? kept[kept.length - 1].id }
}

export function closeSurface(entry: RightPanelEntry, id: string): RightPanelEntry {
  return removeSurfaces(entry, new Set([id]))
}

export function closeOtherSurfaces(entry: RightPanelEntry, id: string): RightPanelEntry {
  if (!entry.surfaces.some((item) => item.id === id)) return entry
  const gone = new Set(entry.surfaces.filter((item) => item.id !== id).map((item) => item.id))
  return { ...removeSurfaces(entry, gone), active: id }
}

export function closeSurfacesToRight(entry: RightPanelEntry, id: string): RightPanelEntry {
  const index = entry.surfaces.findIndex((item) => item.id === id)
  if (index < 0) return entry
  const gone = new Set(entry.surfaces.slice(index + 1).map((item) => item.id))
  const next = removeSurfaces(entry, gone)
  return next.active && entry.surfaces.slice(0, index + 1).some((item) => item.id === next.active) ? next : { ...next, active: id }
}

export function closeAllSurfaces(entry: RightPanelEntry): RightPanelEntry {
  return removeSurfaces(entry, new Set(entry.surfaces.map((item) => item.id)))
}

export function moveSurface(entry: RightPanelEntry, id: string, toIndex: number): RightPanelEntry {
  const from = entry.surfaces.findIndex((item) => item.id === id)
  if (from < 0) return entry
  const to = Math.max(0, Math.min(entry.surfaces.length - 1, Math.trunc(toIndex)))
  if (to === from) return entry
  const surfaces = entry.surfaces.slice()
  const [moved] = surfaces.splice(from, 1)
  surfaces.splice(to, 0, moved)
  return { ...entry, surfaces }
}

export function stepSurface(entry: RightPanelEntry, delta: number): RightPanelEntry {
  if (!entry.surfaces.length) return entry
  const index = Math.max(0, entry.surfaces.findIndex((item) => item.id === entry.active))
  const next = entry.surfaces[(index + delta + entry.surfaces.length * 4) % entry.surfaces.length]
  return activateSurface(entry, next.id)
}

export function replaceSurface(entry: RightPanelEntry, fromId: string, surface: RightPanelSurface): RightPanelEntry {
  const index = entry.surfaces.findIndex((item) => item.id === fromId)
  if (index < 0 || entry.surfaces.some((item) => item.id === surface.id)) return upsertSurface(entry, surface)
  const surfaces = entry.surfaces.map((item, at) => (at === index ? surface : item))
  return { ...entry, open: true, surfaces, active: entry.active === fromId ? surface.id : entry.active }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function sanitizeSurface(value: unknown): RightPanelSurface | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const kind = text(raw.kind)
  if (kind === 'preview') return toolSurface('files')
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

export function sanitizePanelEntry(value: unknown): RightPanelEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (!Array.isArray(raw.surfaces)) return null
  const surfaces: RightPanelSurface[] = []
  for (const item of raw.surfaces) {
    const surface = sanitizeSurface(item)
    if (surface && !surfaces.some((known) => known.id === surface.id)) surfaces.push(surface)
  }
  if (!surfaces.length) return null
  const active = surfaces.some((item) => item.id === raw.active) ? (raw.active as string) : surfaces[surfaces.length - 1].id
  return { open: raw.open === true, active, surfaces, maximized: raw.maximized === true && raw.open === true }
}

export function emptyRightPanelSnapshot(): RightPanelSnapshot {
  return { version: RIGHT_PANEL_VERSION, width: PANEL_WIDTH_DEFAULT, byKey: {}, order: [] }
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
  load: (sessionId: string | null | undefined) => void
  open: (surface: RightPanelSurface) => void
  activate: (id: string) => void
  close: (id: string) => void
  closeOthers: (id: string) => void
  closeRight: (id: string) => void
  closeAll: () => void
  move: (id: string, toIndex: number) => void
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
    load: (sessionId) => {
      const key = panelKeyFor(sessionId)
      const state = get()
      if (state.key === key) return
      const home = state.byKey[HOME_PANEL_KEY]
      if (!state.byKey[key] && state.key === HOME_PANEL_KEY && key !== HOME_PANEL_KEY && home?.surfaces.length) {
        set({ key, ...entryKeyed(state, key, home) })
        return
      }
      set({ key })
    },
    open: (surface) => update((entry) => upsertSurface(entry, surface)),
    activate: (id) => update((entry) => activateSurface(entry, id)),
    close: (id) => update((entry) => closeSurface(entry, id)),
    closeOthers: (id) => update((entry) => closeOtherSurfaces(entry, id)),
    closeRight: (id) => update((entry) => closeSurfacesToRight(entry, id)),
    closeAll: () => update(closeAllSurfaces),
    move: (id, toIndex) => update((entry) => moveSurface(entry, id, toIndex)),
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
  if (state.byKey === previous.byKey && state.order === previous.order && state.width === previous.width) return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    const latest = useRightPanel.getState()
    writeRightPanel({ version: RIGHT_PANEL_VERSION, width: latest.width, byKey: latest.byKey, order: latest.order })
  }, 150)
})
