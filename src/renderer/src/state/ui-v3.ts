/**
 * v3 外壳自己的界面状态：路由、返回栈、侧栏开合。
 *
 * 为什么与主 store 分开：这些是「v3 外壳正在看什么、开没开」的界面事实，
 * v2 外壳没有对应概念。会话内容、运行状态、设置仍读主 store，两边共用。
 *
 * 路由是**最小实现**：只有 chat / runs / settings / schedule / review 五个位置，够 WP-20 与
 * 随后的独立页面用；命令面板等还没就位的页面等到对应工单再挂进来，这里不预建空壳。
 * 路由与 `location.hash` 双向同步，动作永远由界面发起 —— 深链接只导航、不执行。
 */
import { useEffect } from 'react'
import { create } from 'zustand'
import { WORKBENCH_ACTIVE_TABS, WORKBENCH_TABS, type WorkbenchTabId, type WorkbenchView } from '../features/workbench/types'

export type V3RouteName = 'chat' | 'runs' | 'settings' | 'schedule' | 'review' | 'usage'

export interface V3Route {
  name: V3RouteName
}

/* ── v3 本地界面偏好（版本化） ──────────────────────────────────
 * 与 v2 的设置分开存：v3 的外壳偏好（工作区上次页签）不是 v2 的
 * `rightPanelOpen`，互不覆盖、互不迁移。未知版本只回默认值。
 */
const PREFS_KEY = 'inkstone.v3.prefs'

export interface V3UiPrefs {
  version: 1
  /** 上次停留的工作区视图（概览或某个工具）；工作区面板本身每次启动默认关闭 */
  workbenchTab: WorkbenchView
}

function isWorkbenchTab(value: unknown): value is WorkbenchTabId {
  return typeof value === 'string' && (WORKBENCH_TABS as readonly string[]).includes(value)
}

function isWorkbenchView(value: unknown): value is WorkbenchView {
  return value === 'overview' || isWorkbenchTab(value)
}

/**
 * 启动时恢复工作区页签的安全值。
 *
 * 终端 / 浏览器页签要「会话已激活」才会真正启动资源。如果把持久化偏好里的
 * 这两个页签直接当成初始 `activeTab`，用户只是点开工作区（并没有点这个页签）
 * 就会隐式起 PTY / 打开原生网页 —— 正是隔离探针在截图里暴露的越界。恢复阶段
 * 一律降级到只读的「改动」页；用户本次会话里明确点击终端 / 浏览器页签时才允许
 * 起资源，不额外加确认步骤。
 *
 * 以后新增页签时同样规则：只要它在 `WORKBENCH_ACTIVE_TABS` 里就降级，只读页签
 *（如 `context`）原样恢复。判定只看这张表，不在白名单里单独列。
 * 降级目标是概览：概览不带任何资源，不会隐式启动终端或浏览器。
 */
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
    /* 偏好写失败不影响本次使用 */
  }
}

interface UiV3State {
  route: V3Route
  /** 返回栈（`Alt+←` 用）。只留最近 20 条，避免长期使用后无限增长。 */
  back: V3Route[]
  /** 侧栏是否展开；窄窗时展开表现为浮层 */
  sidebarOpen: boolean
  /** 右侧工作区面板是否展开；每次启动默认关闭，不持久化展开态 */
  workspaceOpen: boolean
  /** 上次停留的工作区视图（概览或某个工具）；持久化在版本化的本地界面偏好里 */
  workspaceTab: WorkbenchView
  /** 面板是否上下拆成两格（不持久化；专注时忽略） */
  workspaceSplit: boolean
  /** 下半格显示的页签；与主格不同由面板保证 */
  workspaceSplitTab: WorkbenchTabId
  /** 专注：面板占满主区，只留当前页签一块（不持久化） */
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
  workspaceOpen: false,
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
  setWorkspaceOpen: (open) => set({ workspaceOpen: open }),
  toggleWorkspace: () => set({ workspaceOpen: !get().workspaceOpen }),
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

/** 测试用：读出当前持久化的本地偏好，不改状态。 */
export function readUiPrefsForTest(): V3UiPrefs {
  return readUiPrefs()
}

/** hash → 路由；认不出来的（旧链接、手输）一律回到对话。 */
export function routeFromHash(hash: string): V3Route {
  const name = hash.replace(/^#\/?/, '')
  if (name === 'settings') return { name: 'settings' }
  if (name === 'runs') return { name: 'runs' }
  if (name === 'schedule') return { name: 'schedule' }
  if (name === 'review') return { name: 'review' }
  if (name === 'usage') return { name: 'usage' }
  return { name: 'chat' }
}

/** 路由 → hash；chat 是默认页，写 `#/` 保持地址栏可见但不产生历史噪音。 */
export function hashForRoute(route: V3Route): string {
  return route.name === 'chat' ? '#/' : `#/${route.name}`
}

/**
 * 路由与 `location.hash` 双向同步。在 ShellV3 里挂一次。
 *
 * 用 `replaceState` 而不是直接改 `location.hash`：改 hash 会再触发一次
 * `hashchange`，把刚设好的路由又回写一遍（虽然幂等，但多一轮无谓更新）。
 */
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
