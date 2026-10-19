import { useEffect } from 'react'
import { create } from 'zustand'
import { WORKBENCH_ACTIVE_TABS, WORKBENCH_TABS, type WorkbenchTabId, type WorkbenchView } from '../features/workbench/types'
import { appendTile, columnLayout, hasTile, orderedTileIds, removeTile, sanitizeLayout, type TileLayout } from '../features/workbench/tile-tree'

export type V3RouteName = 'chat' | 'schedule' | 'collab' | 'usage'

export interface V3Route {
  name: V3RouteName
}

const PREFS_KEY = 'inkstone.v3.prefs'

export interface V3UiPrefs {
  version: 1
  workbenchTab: WorkbenchView
}

function isWorkbenchTab(value: unknown): value is WorkbenchTabId {
  return typeof value === 'string' && (WORKBENCH_TABS as readonly string[]).includes(value)
}

function isWorkbenchView(value: unknown): value is WorkbenchView {
  return value === 'overview' || isWorkbenchTab(value)
}

export function restorableWorkbenchTab(view: WorkbenchView): WorkbenchView {
  return view !== 'overview' && WORKBENCH_ACTIVE_TABS.has(view) ? 'overview' : view
}

function readUiPrefs(): V3UiPrefs {
  const fallback: V3UiPrefs = { version: 1, workbenchTab: 'overview' }
  if (typeof localStorage === 'undefined') return fallback
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null') as Partial<V3UiPrefs> | null
    if (!raw || raw.version !== 1 || !isWorkbenchView(raw.workbenchTab)) return fallback
    return { version: 1, workbenchTab: restorableWorkbenchTab(raw.workbenchTab) }
  } catch {
    return fallback
  }
}

function writeUiPrefs(prefs: V3UiPrefs): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
  }
}

const WORKSPACE_OPEN_KEY = 'inkstone.v3.workspaceOpen'
const WORKSPACE_PANES_KEY = 'inkstone.v3.workspacePanes'
const WORKSPACE_LAYOUT_KEY = 'inkstone.v3.workspaceLayout'

export function workspaceLayoutFor(layout: TileLayout | null, panes: readonly WorkbenchTabId[]): TileLayout {
  let next = layout ?? columnLayout([])
  for (const id of orderedTileIds(next)) if (!(panes as readonly string[]).includes(id)) next = removeTile(next, id)
  for (const id of panes) if (!hasTile(next, id)) next = appendTile(next, id)
  return next
}

function readWorkspaceLayout(panes: readonly WorkbenchTabId[]): TileLayout {
  if (typeof localStorage === 'undefined') return workspaceLayoutFor(null, panes)
  try {
    const stored = sanitizeLayout(JSON.parse(localStorage.getItem(WORKSPACE_LAYOUT_KEY) ?? 'null'), new Set<string>(panes))
    return workspaceLayoutFor(stored, panes)
  } catch {
    return workspaceLayoutFor(null, panes)
  }
}

function writeWorkspaceLayout(layout: TileLayout): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(WORKSPACE_LAYOUT_KEY, JSON.stringify(layout))
  } catch {
  }
}

export function restorableWorkspacePanes(value: unknown, fallback: WorkbenchView): WorkbenchTabId[] {
  const out: WorkbenchTabId[] = []
  const list = Array.isArray(value) ? value : fallback === 'overview' ? [] : [fallback]
  for (const raw of list) {
    const item = raw === 'preview' ? 'files' : raw
    if (!isWorkbenchTab(item) || WORKBENCH_ACTIVE_TABS.has(item) || out.includes(item)) continue
    out.push(item)
  }
  return out
}

function readWorkspacePanes(fallback: WorkbenchView): WorkbenchTabId[] {
  if (typeof localStorage === 'undefined') return restorableWorkspacePanes(null, fallback)
  try {
    return restorableWorkspacePanes(JSON.parse(localStorage.getItem(WORKSPACE_PANES_KEY) ?? 'null'), fallback)
  } catch {
    return restorableWorkspacePanes(null, fallback)
  }
}

function writeWorkspacePanes(panes: readonly WorkbenchTabId[]): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(WORKSPACE_PANES_KEY, JSON.stringify(panes))
  } catch {
  }
}

export function withWorkspacePane(panes: readonly WorkbenchTabId[], tab: WorkbenchTabId): WorkbenchTabId[] {
  return panes.includes(tab) ? [...panes] : [...panes, tab]
}

export function withoutWorkspacePane(panes: readonly WorkbenchTabId[], tab: WorkbenchTabId): WorkbenchTabId[] {
  return panes.filter((item) => item !== tab)
}

function readWorkspaceOpen(): boolean {
  if (typeof localStorage === 'undefined') return true
  try {
    return localStorage.getItem(WORKSPACE_OPEN_KEY) !== '0'
  } catch {
    return true
  }
}

function writeWorkspaceOpen(open: boolean): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(WORKSPACE_OPEN_KEY, open ? '1' : '0')
  } catch {
  }
}

interface UiV3State {
  route: V3Route
  back: V3Route[]
  sidebarOpen: boolean
  workspaceOpen: boolean
  workspaceTab: WorkbenchView
  workspacePanes: WorkbenchTabId[]
  workspaceLayout: TileLayout
  workspaceSplit: boolean
  workspaceSplitTab: WorkbenchTabId
  workspaceFocus: boolean
  navigate: (route: V3Route) => void
  goBack: () => void
  setSidebarOpen: (open: boolean) => void
  toggleSidebar: () => void
  setWorkspaceOpen: (open: boolean) => void
  toggleWorkspace: () => void
  setWorkspaceTab: (view: WorkbenchView) => void
  closeWorkspacePane: (tab: WorkbenchTabId) => void
  reorderWorkspacePanes: (panes: WorkbenchTabId[]) => void
  setWorkspaceLayout: (layout: TileLayout) => void
  setWorkspaceSplit: (open: boolean) => void
  toggleWorkspaceSplit: () => void
  setWorkspaceSplitTab: (tab: WorkbenchTabId) => void
  setWorkspaceFocus: (on: boolean) => void
  toggleWorkspaceFocus: () => void
}

function initialWorkspace(): { workspaceTab: WorkbenchView; workspacePanes: WorkbenchTabId[]; workspaceLayout: TileLayout } {
  const stored = readUiPrefs().workbenchTab
  const panes = readWorkspacePanes(stored)
  const tab = stored !== 'overview' && panes.includes(stored) ? stored : panes[panes.length - 1] ?? 'overview'
  return { workspaceTab: tab, workspacePanes: panes, workspaceLayout: readWorkspaceLayout(panes) }
}

export const useUiV3 = create<UiV3State>((set, get) => ({
  route: { name: 'chat' },
  back: [],
  sidebarOpen: true,
  workspaceOpen: readWorkspaceOpen(),
  ...initialWorkspace(),
  workspaceSplit: false,
  workspaceSplitTab: 'context',
  workspaceFocus: false,
  navigate: (route) => {
    if (route.name === get().route.name) return
    set({ route, back: [...get().back, get().route].slice(-20) })
  },
  goBack: () => {
    const back = get().back
    const target = back.length ? back[back.length - 1] : ({ name: 'chat' } as V3Route)
    if (target.name === get().route.name && !back.length) return
    set({ route: target, back: back.slice(0, -1) })
  },
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  toggleSidebar: () => set({ sidebarOpen: !get().sidebarOpen }),
  setWorkspaceOpen: (open) => {
    set({ workspaceOpen: open })
    writeWorkspaceOpen(open)
  },
  toggleWorkspace: () => get().setWorkspaceOpen(!get().workspaceOpen),
  setWorkspaceTab: (requested) => {
    if (!isWorkbenchView(requested)) return
    const view = requested === 'preview' ? 'files' : requested
    const panes = view === 'overview' ? [] : withWorkspacePane(get().workspacePanes, view)
    const layout = workspaceLayoutFor(get().workspaceLayout, panes)
    set({ workspaceTab: view, workspacePanes: panes, workspaceLayout: layout })
    writeUiPrefs({ version: 1, workbenchTab: view })
    writeWorkspacePanes(panes)
    writeWorkspaceLayout(layout)
  },
  reorderWorkspacePanes: (panes) => {
    const current = get().workspacePanes
    if (panes.length !== current.length || !panes.every((tab) => current.includes(tab))) return
    if (panes.every((tab, index) => current[index] === tab)) return
    const layout = columnLayout(panes)
    set({ workspacePanes: [...panes], workspaceLayout: layout })
    writeWorkspacePanes(panes)
    writeWorkspaceLayout(layout)
  },
  setWorkspaceLayout: (layout) => {
    const current = get().workspacePanes
    const ids = orderedTileIds(layout)
    if (ids.length !== current.length || !ids.every((id) => (current as readonly string[]).includes(id))) return
    const panes = ids as WorkbenchTabId[]
    set({ workspaceLayout: layout, workspacePanes: panes })
    writeWorkspacePanes(panes)
    writeWorkspaceLayout(layout)
  },
  closeWorkspacePane: (tab) => {
    const state = get()
    const panes = withoutWorkspacePane(state.workspacePanes, tab)
    const view: WorkbenchView = state.workspaceTab === tab || panes.length === 0 ? panes[panes.length - 1] ?? 'overview' : state.workspaceTab
    const layout = workspaceLayoutFor(state.workspaceLayout, panes)
    set({ workspacePanes: panes, workspaceLayout: layout, workspaceTab: view, workspaceFocus: state.workspaceFocus && panes.length > 0 && view === state.workspaceTab })
    writeUiPrefs({ version: 1, workbenchTab: view })
    writeWorkspacePanes(panes)
    writeWorkspaceLayout(layout)
    if (panes.length === 0) get().setWorkspaceOpen(false)
  },
  setWorkspaceSplit: (open) => set({ workspaceSplit: open }),
  toggleWorkspaceSplit: () => set({ workspaceSplit: !get().workspaceSplit }),
  setWorkspaceSplitTab: (tab) => {
    if (!isWorkbenchTab(tab)) return
    set({ workspaceSplitTab: tab })
  },
  setWorkspaceFocus: (on) => set({ workspaceFocus: on }),
  toggleWorkspaceFocus: () => set({ workspaceFocus: !get().workspaceFocus })
}))

export function readUiPrefsForTest(): V3UiPrefs {
  return readUiPrefs()
}

export function routeFromHash(hash: string): V3Route {
  const name = hash.replace(/^#\/?/, '')
  if (name === 'schedule') return { name: 'schedule' }
  if (name === 'collab') return { name: 'collab' }
  if (name === 'usage') return { name: 'usage' }
  return { name: 'chat' }
}

export function hashForRoute(route: V3Route): string {
  return route.name === 'chat' ? '#/' : `#/${route.name}`
}

export function useV3RouteSync(): void {
  useEffect(() => {
    const applyHash = (): void => {
      useUiV3.setState({ route: routeFromHash(window.location.hash) })
    }
    const early = useUiV3.getState().route
    if (early.name !== 'chat' && routeFromHash(window.location.hash).name === 'chat') {
      window.history.replaceState(null, '', hashForRoute(early))
    } else {
      applyHash()
    }
    window.addEventListener('hashchange', applyHash)
    const unsubscribe = useUiV3.subscribe((state, previous) => {
      if (state.route === previous.route) return
      const next = hashForRoute(state.route)
      if (window.location.hash !== next) window.history.replaceState(null, '', next)
    })
    return () => {
      window.removeEventListener('hashchange', applyHash)
      unsubscribe()
    }
  }, [])
}
