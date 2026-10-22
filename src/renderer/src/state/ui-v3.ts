import { useEffect } from 'react'
import { create } from 'zustand'
import { WORKBENCH_ACTIVE_TABS, WORKBENCH_TABS, type WorkbenchTabId, type WorkbenchView, type WorkspacePaneId, type WorkspaceView } from '../features/workbench/types'
import { chatFlexOf, chatOnlyLayout, columnLayout, flexChanges, hasTile, layoutWithChat, openPane, orderedTileIds, panesLayoutOf, removeTile, CHAT_TILE_ID, type TileLayout } from '../features/workbench/tile-tree'
import { isSubagentPaneId } from '../features/workbench/subagent-panes'
import {
  HOME_LAYOUT_KEY,
  collapseLayoutEntry,
  emptyTileLayoutEntry,
  migrateLegacyTileLayouts,
  panesOfEntry,
  readPaneFlexByKind,
  readTileLayoutEntry,
  rememberPaneFlexByKind,
  sessionLayoutKey,
  toggleExpandedEntry,
  withLayoutEntry,
  withoutLayoutTiles,
  writeTileLayoutEntry,
  type TileLayoutEntry
} from './tile-layouts'

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

function isWorkspaceView(value: unknown): value is WorkspaceView {
  return isWorkbenchView(value) || isSubagentPaneId(value)
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

export function workspaceLayoutFor(layout: TileLayout | null, panes: readonly WorkspacePaneId[]): TileLayout {
  const current = layout && hasTile(layout, CHAT_TILE_ID) ? orderedTileIds(layout).filter((id) => id !== CHAT_TILE_ID) : null
  if (layout && current && current.length === panes.length && current.every((id, index) => id === panes[index])) return layout
  const flexByKind = readPaneFlexByKind()
  let next: TileLayout | null = layout
  for (const id of layout ? orderedTileIds(layout).filter((id) => id !== CHAT_TILE_ID) : []) {
    if (!(panes as readonly string[]).includes(id)) next = removeTile(next as TileLayout, id)
  }
  for (const id of panes) next = openPane(next, id, flexByKind)
  return next && hasTile(next, CHAT_TILE_ID) ? next : layoutWithChat(next, chatFlexOf(layout))
}

export function withWorkspacePane(panes: readonly WorkspacePaneId[], tab: WorkspacePaneId): WorkspacePaneId[] {
  return panes.includes(tab) ? [...panes] : [...panes, tab]
}

function writeFocusPrefs(view: WorkspaceView): void {
  if (isWorkbenchView(view)) writeUiPrefs({ version: 1, workbenchTab: view })
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
  layoutKey: string
  workspaceOpen: boolean
  workspaceTab: WorkspaceView
  workspacePanes: WorkspacePaneId[]
  workspaceLayout: TileLayout
  workspaceBaseLayout: TileLayout | null
  workspaceExpandedTile: string | null
  workspaceSplit: boolean
  workspaceSplitTab: WorkbenchTabId
  workspaceFocus: boolean
  navigate: (route: V3Route) => void
  goBack: () => void
  setSidebarOpen: (open: boolean) => void
  toggleSidebar: () => void
  setWorkspaceOpen: (open: boolean) => void
  toggleWorkspace: () => void
  loadLayoutSession: (sessionId: string | null | undefined) => void
  setWorkspaceTab: (view: WorkspaceView) => void
  closeWorkspacePane: (tab: WorkspacePaneId) => void
  dropWorkspacePanes: (tabs: readonly WorkspacePaneId[]) => void
  setWorkspaceLayout: (layout: TileLayout, changedKeys?: readonly string[]) => void
  setWorkspaceSplit: (open: boolean) => void
  toggleWorkspaceSplit: () => void
  setWorkspaceSplitTab: (tab: WorkbenchTabId) => void
  setWorkspaceFocus: (on: boolean) => void
  toggleWorkspaceFocus: () => void
  toggleWorkspaceExpanded: (tab?: WorkspacePaneId) => void
}

function restoreView(view: WorkspaceView): WorkspaceView {
  return isWorkbenchView(view) ? restorableWorkbenchTab(view) : view
}

function resolveTab(entry: TileLayoutEntry, panes: readonly WorkspacePaneId[], preferred: WorkspaceView): WorkspaceView {
  const includes = (view: WorkspaceView): boolean => view !== 'overview' && (panes as readonly string[]).includes(view)
  if (entry.expandedTile && includes(entry.expandedTile as WorkspaceView)) return entry.expandedTile as WorkspaceView
  if (includes(preferred)) return preferred
  return panes[panes.length - 1] ?? 'overview'
}

function initialWorkspace(): Pick<UiV3State, 'layoutKey' | 'workspaceTab' | 'workspacePanes' | 'workspaceLayout' | 'workspaceBaseLayout' | 'workspaceExpandedTile' | 'workspaceFocus'> {
  migrateLegacyTileLayouts()
  const entry = readTileLayoutEntry(HOME_LAYOUT_KEY) ?? emptyTileLayoutEntry()
  const panes = panesOfEntry(entry) as WorkspacePaneId[]
  return {
    layoutKey: HOME_LAYOUT_KEY,
    workspaceTab: entry.expandedTile ? resolveTab(entry, panes, 'overview') : restoreView(resolveTab(entry, panes, readUiPrefs().workbenchTab)),
    workspacePanes: panes,
    workspaceLayout: entry.tileLayout,
    workspaceBaseLayout: entry.baseLayout,
    workspaceExpandedTile: entry.expandedTile,
    workspaceFocus: entry.expandedTile !== null
  }
}

let startupRestore = true

export const useUiV3 = create<UiV3State>((set, get) => {
  const entryOf = (key: string): TileLayoutEntry => {
    const state = get()
    if (state.layoutKey === key) {
      return { tileLayout: state.workspaceLayout, baseLayout: state.workspaceBaseLayout, expandedTile: state.workspaceExpandedTile }
    }
    return readTileLayoutEntry(key) ?? emptyTileLayoutEntry(chatFlexOf(state.workspaceLayout))
  }

  const commit = (key: string, entry: TileLayoutEntry, override?: WorkspaceView): void => {
    writeTileLayoutEntry(key, entry)
    const state = get()
    const panes = panesOfEntry(entry) as WorkspacePaneId[]
    const current = state.workspaceTab
    const preferred: WorkspaceView =
      override && (override === 'overview' || (panes as readonly string[]).includes(override))
        ? override
        : current !== 'overview' && (panes as readonly string[]).includes(current)
          ? current
          : readUiPrefs().workbenchTab
    const tab = resolveTab(entry, panes, preferred)
    set({
      layoutKey: key,
      workspacePanes: panes,
      workspaceLayout: entry.tileLayout,
      workspaceBaseLayout: entry.baseLayout,
      workspaceExpandedTile: entry.expandedTile,
      workspaceFocus: entry.expandedTile !== null,
      workspaceTab: tab
    })
    if (tab !== current) writeFocusPrefs(tab)
  }

  return {
  route: { name: 'chat' },
  back: [],
  sidebarOpen: true,
  workspaceOpen: readWorkspaceOpen(),
  ...initialWorkspace(),
  workspaceSplit: false,
  workspaceSplitTab: 'context',
  navigate: (route) => {
    if (route.name === get().route.name) return
    set({ route, back: [...get().back, get().route].slice(-20) })
  },
  goBack: () => {
    // 定时任务 / 多人协作 / 用量是左栏的平级页面，不是聊天的子页。
    // 历史栈回退会让“按返回”退到上一个平级页（或在 hash 同步后停在当前页），
    // 看起来就是点了没反应，所以这里一律回聊天。
    if (get().route.name === 'chat') return
    set({ route: { name: 'chat' }, back: [] })
  },
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  toggleSidebar: () => set({ sidebarOpen: !get().sidebarOpen }),
  setWorkspaceOpen: (open) => {
    set({ workspaceOpen: open })
    writeWorkspaceOpen(open)
  },
  toggleWorkspace: () => get().setWorkspaceOpen(!get().workspaceOpen),
  loadLayoutSession: (sessionId) => {
    const key = sessionLayoutKey(sessionId)
    const state = get()
    if (state.layoutKey === key) return
    let entry = readTileLayoutEntry(key)
    if (!entry && state.layoutKey === HOME_LAYOUT_KEY) {
      const home = readTileLayoutEntry(HOME_LAYOUT_KEY)
      if (home && (panesOfEntry(home).length > 0 || home.expandedTile)) {
        entry = home
        writeTileLayoutEntry(key, home)
      }
    }
    const next = entry ?? emptyTileLayoutEntry(chatFlexOf(state.workspaceLayout))
    const panes = panesOfEntry(next) as WorkspacePaneId[]
    const resolved = resolveTab(next, panes, readUiPrefs().workbenchTab)
    const tab = startupRestore && !next.expandedTile ? restoreView(resolved) : resolved
    startupRestore = false
    set({
      layoutKey: key,
      workspacePanes: panes,
      workspaceLayout: next.tileLayout,
      workspaceBaseLayout: next.baseLayout,
      workspaceExpandedTile: next.expandedTile,
      workspaceFocus: next.expandedTile !== null,
      workspaceTab: tab,
      workspaceOpen: panes.length > 0 ? true : state.workspaceOpen
    })
  },
  setWorkspaceTab: (requested) => {
    if (!isWorkspaceView(requested)) return
    const view = requested === 'preview' ? 'files' : requested
    const key = get().layoutKey
    const entry = entryOf(key)
    writeFocusPrefs(view)
    if (view === 'overview') {
      commit(key, { tileLayout: chatOnlyLayout(chatFlexOf(entry.tileLayout)), baseLayout: null, expandedTile: null }, 'overview')
      return
    }
    const base = entry.expandedTile ? entry.baseLayout ?? entry.tileLayout : entry.tileLayout
    const panes = withWorkspacePane(get().workspacePanes, view)
    const layout = workspaceLayoutFor(base, panes)
    if (entry.expandedTile) {
      commit(key, { tileLayout: columnLayout([view]), baseLayout: layout, expandedTile: view }, view)
      return
    }
    commit(key, withLayoutEntry(entry, layout), view)
  },
  setWorkspaceLayout: (layout, changedKeys) => {
    const state = get()
    if (state.workspaceExpandedTile) return
    const current = state.workspacePanes
    const ids = orderedTileIds(layout).filter((id) => id !== CHAT_TILE_ID)
    if (ids.length !== current.length || !ids.every((id) => (current as readonly string[]).includes(id))) return
    const previous = state.workspaceLayout
    const full = hasTile(layout, CHAT_TILE_ID) ? layout : layoutWithChat(panesLayoutOf(layout), chatFlexOf(previous))
    const key = state.layoutKey
    commit(key, withLayoutEntry(entryOf(key), full))
    rememberPaneFlexByKind(full, changedKeys ?? flexChanges(previous, full))
  },
  closeWorkspacePane: (tab) => get().dropWorkspacePanes([tab]),
  dropWorkspacePanes: (tabs) => {
    const state = get()
    const gone = new Set<string>(tabs)
    if (!state.workspacePanes.some((item) => gone.has(item))) return
    const key = state.layoutKey
    const next = withoutLayoutTiles(entryOf(key), gone)
    commit(key, next)
    if (panesOfEntry(next).length === 0) get().setWorkspaceOpen(false)
  },
  setWorkspaceSplit: (open) => set({ workspaceSplit: open }),
  toggleWorkspaceSplit: () => set({ workspaceSplit: !get().workspaceSplit }),
  setWorkspaceSplitTab: (tab) => {
    if (!isWorkbenchTab(tab)) return
    set({ workspaceSplitTab: tab })
  },
  setWorkspaceFocus: (on) => {
    const state = get()
    if (!on) {
      if (!state.workspaceExpandedTile) return
      commit(state.layoutKey, collapseLayoutEntry(entryOf(state.layoutKey)))
      return
    }
    if (state.workspaceExpandedTile) return
    get().toggleWorkspaceExpanded()
  },
  toggleWorkspaceFocus: () => {
    get().setWorkspaceFocus(!get().workspaceExpandedTile)
  },
  toggleWorkspaceExpanded: (tab) => {
    const state = get()
    const target = tab ?? (state.workspaceTab !== 'overview' ? state.workspaceTab : state.workspacePanes[state.workspacePanes.length - 1])
    if (!target || !(state.workspacePanes as readonly string[]).includes(target)) return
    const key = state.layoutKey
    const entry = entryOf(key)
    const next = toggleExpandedEntry(entry, target)
    if (next === entry) return
    commit(key, next, next.expandedTile ? (next.expandedTile as WorkspacePaneId) : undefined)
  }
  }
})

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
