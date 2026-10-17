import { useEffect } from 'react'
import { create } from 'zustand'
import { WORKBENCH_ACTIVE_TABS, WORKBENCH_TABS, type WorkbenchTabId, type WorkbenchView } from '../features/workbench/types'

export type V3RouteName = 'chat' | 'runs' | 'settings' | 'schedule' | 'review' | 'collab' | 'usage'

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
  setWorkspaceSplit: (open: boolean) => void
  toggleWorkspaceSplit: () => void
  setWorkspaceSplitTab: (tab: WorkbenchTabId) => void
  setWorkspaceFocus: (on: boolean) => void
  toggleWorkspaceFocus: () => void
}

export const useUiV3 = create<UiV3State>((set, get) => ({
  route: { name: 'chat' },
  back: [],
  sidebarOpen: true,
  workspaceOpen: readWorkspaceOpen(),
  workspaceTab: readUiPrefs().workbenchTab,
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
  setWorkspaceTab: (view) => {
    if (!isWorkbenchView(view)) return
    set({ workspaceTab: view })
    writeUiPrefs({ version: 1, workbenchTab: view })
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
  if (name === 'settings') return { name: 'settings' }
  if (name === 'runs') return { name: 'runs' }
  if (name === 'schedule') return { name: 'schedule' }
  if (name === 'review') return { name: 'review' }
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
    applyHash()
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
