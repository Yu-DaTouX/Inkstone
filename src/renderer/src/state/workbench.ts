/**
 * 右栏工作窗口的轻量布局状态。
 *
 * 资源本身仍由浏览器 / 文件 / 子代理各自的 owner 管理；这里只保存
 * 用户可恢复的标签和布局，不把 Cookie、凭证或会话正文复制进第二份真源。
 */
export type WorkbenchView = 'tools' | 'review' | 'browser' | 'file' | 'subagent'

export interface WorkbenchTab {
  id: string
  kind: WorkbenchView
  resourceKey?: string
  title?: string
}

export interface WorkbenchState {
  version: 1
  tabs: WorkbenchTab[]
  activeTabId: string
  width: number
  expanded: boolean
}

const STORAGE_KEY = 'yan.workbench.v1'
const DEFAULT_TABS: WorkbenchTab[] = [{ id: 'tools', kind: 'tools', title: '工具' }]

function isView(value: unknown): value is WorkbenchView {
  return value === 'tools' || value === 'review' || value === 'browser' || value === 'file' || value === 'subagent'
}

export function defaultWorkbenchState(): WorkbenchState {
  return { version: 1, tabs: DEFAULT_TABS.map((tab) => ({ ...tab })), activeTabId: 'tools', width: 0, expanded: true }
}

export function normalizeWorkbenchState(value: unknown): WorkbenchState {
  const fallback = defaultWorkbenchState()
  if (!value || typeof value !== 'object') return fallback
  const input = value as Partial<WorkbenchState>
  const tabs = Array.isArray(input.tabs)
    ? input.tabs.flatMap((tab) => {
        if (!tab || typeof tab !== 'object') return []
        const item = tab as Partial<WorkbenchTab>
        if (typeof item.id !== 'string' || !isView(item.kind)) return []
        return [{ id: item.id, kind: item.kind, ...(typeof item.resourceKey === 'string' ? { resourceKey: item.resourceKey } : {}), ...(typeof item.title === 'string' ? { title: item.title } : {}) }]
      })
    : []
  const unique = tabs.filter((tab, index) => tabs.findIndex((candidate) => candidate.id === tab.id) === index)
  if (!unique.some((tab) => tab.id === 'tools')) unique.unshift({ ...fallback.tabs[0] })
  const activeTabId = unique.some((tab) => tab.id === input.activeTabId) ? input.activeTabId! : 'tools'
  const width = typeof input.width === 'number' && Number.isFinite(input.width) && input.width >= 0 ? Math.round(input.width) : 0
  return {
    version: 1,
    tabs: unique,
    activeTabId,
    width,
    expanded: input.expanded !== false
  }
}

export function workbenchSessionKey(sessionFile?: string, sessionId?: string): string {
  return sessionFile || sessionId || 'pending'
}

export function activateWorkbenchTab(state: WorkbenchState, kind: WorkbenchView, resourceKey?: string): WorkbenchState {
  const id = resourceKey ? `${kind}:${resourceKey}` : kind
  const existing = state.tabs.find((tab) => tab.id === id)
  const tabs = existing ? state.tabs : [...state.tabs, { id, kind, ...(resourceKey ? { resourceKey } : {}) }]
  return { ...state, tabs, activeTabId: id }
}

export function closeWorkbenchTab(state: WorkbenchState, id: string): WorkbenchState {
  if (id === 'tools') return { ...state, activeTabId: 'tools' }
  const tabs = state.tabs.filter((tab) => tab.id !== id)
  return { ...state, tabs, activeTabId: state.activeTabId === id ? (tabs.at(-1)?.id ?? 'tools') : state.activeTabId }
}

export function loadWorkbenchState(key: string): WorkbenchState {
  if (typeof localStorage === 'undefined') return defaultWorkbenchState()
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const map = raw ? JSON.parse(raw) as Record<string, unknown> : {}
    return normalizeWorkbenchState(map[key])
  } catch {
    return defaultWorkbenchState()
  }
}

export function saveWorkbenchState(key: string, state: WorkbenchState): void {
  if (typeof localStorage === 'undefined') return
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const map = raw ? JSON.parse(raw) as Record<string, unknown> : {}
    map[key] = normalizeWorkbenchState(state)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    /* 布局偏好写失败不影响资源与会话 */
  }
}

export function viewFromWorkbench(state: WorkbenchState, available: Set<WorkbenchView>): WorkbenchView {
  const active = state.tabs.find((tab) => tab.id === state.activeTabId)
  return active && available.has(active.kind) ? active.kind : 'tools'
}
