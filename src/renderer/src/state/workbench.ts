export type WorkbenchView = 'start' | 'tools' | 'review' | 'browser' | 'file' | 'subagent' | 'terminal'

export type WorkbenchResourceView = Exclude<WorkbenchView, 'start' | 'tools'>

export interface WorkbenchTab {
  id: string
  kind: WorkbenchView
  resourceKey?: string
  title?: string
}

export interface WorkbenchState {
  version: 2
  tabs: WorkbenchTab[]
  activeTabId: string
  width: number
  expanded: boolean
}

export const PENDING_SESSION_KEY = 'pending'

export const HOME_TAB_ID = 'start'

const STORAGE_KEY = 'yan.workbench.v1'
const CURRENT_VERSION = 2
const VIEWS: readonly WorkbenchView[] = ['start', 'tools', 'review', 'browser', 'file', 'subagent', 'terminal']
const FIXED_VIEWS = new Set<WorkbenchView>(['start', 'tools'])

function isView(value: unknown): value is WorkbenchView {
  return typeof value === 'string' && (VIEWS as readonly string[]).includes(value)
}

export function isFixedView(kind: WorkbenchView): boolean {
  return FIXED_VIEWS.has(kind)
}

export function resourceTabId(kind: WorkbenchView, resourceKey?: string): string {
  return resourceKey ? `${kind}:${resourceKey}` : kind
}

export function defaultWorkbenchState(): WorkbenchState {
  return {
    version: CURRENT_VERSION,
    tabs: [
      { id: HOME_TAB_ID, kind: 'start', title: '开始' },
      { id: 'tools', kind: 'tools', title: '工具' }
    ],
    activeTabId: HOME_TAB_ID,
    width: 0,
    expanded: true
  }
}

function sanitizeWidth(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0
}

function sanitizeTabs(value: unknown): WorkbenchTab[] {
  const raw = Array.isArray(value) ? value : []
  const tabs = raw.flatMap((tab) => {
    if (!tab || typeof tab !== 'object') return []
    const item = tab as Partial<WorkbenchTab>
    if (typeof item.id !== 'string' || !isView(item.kind)) return []
    if (item.kind === 'subagent') return []
    if (item.kind === 'file' && typeof item.resourceKey !== 'string') return []
    if (item.kind === 'terminal' && typeof item.resourceKey !== 'string') return []
    return [{
      id: item.id,
      kind: item.kind,
      ...(typeof item.resourceKey === 'string' ? { resourceKey: item.resourceKey } : {}),
      ...(typeof item.title === 'string' ? { title: item.title } : {})
    }]
  })
  return tabs.filter((tab, index) => tabs.findIndex((candidate) => candidate.id === tab.id) === index)
}

export function normalizeWorkbenchState(value: unknown): WorkbenchState {
  const fallback = defaultWorkbenchState()
  if (!value || typeof value !== 'object') return fallback
  const input = value as Record<string, unknown>
  const version = typeof input.version === 'number' && Number.isInteger(input.version) ? input.version : 1
  const width = sanitizeWidth(input.width)
  const expanded = input.expanded !== false
  if (version < 1 || version > CURRENT_VERSION) {
    return { ...fallback, width, expanded }
  }
  const tabs = sanitizeTabs(input.tabs)
  if (!tabs.some((tab) => tab.id === HOME_TAB_ID)) tabs.unshift({ id: HOME_TAB_ID, kind: 'start', title: '开始' })
  if (!tabs.some((tab) => tab.id === 'tools')) tabs.push({ id: 'tools', kind: 'tools', title: '工具' })
  const activeTabId = typeof input.activeTabId === 'string' && tabs.some((tab) => tab.id === input.activeTabId)
    ? input.activeTabId
    : HOME_TAB_ID
  return { version: CURRENT_VERSION, tabs, activeTabId, width, expanded }
}

export function activateWorkbenchTab(state: WorkbenchState, kind: WorkbenchView, resourceKey?: string): WorkbenchState {
  const id = resourceTabId(kind, resourceKey)
  const existing = state.tabs.find((tab) => tab.id === id)
  const tabs = existing ? state.tabs : [...state.tabs, { id, kind, ...(resourceKey ? { resourceKey } : {}) }]
  return { ...state, tabs, activeTabId: id }
}

export function closeWorkbenchTab(state: WorkbenchState, id: string): WorkbenchState {
  const target = state.tabs.find((tab) => tab.id === id)
  if (!target || isFixedView(target.kind)) {
    const fallback = state.tabs.find((tab) => tab.id === HOME_TAB_ID)?.id
      ?? state.tabs.find((tab) => isFixedView(tab.kind))?.id
      ?? HOME_TAB_ID
    return { ...state, activeTabId: fallback }
  }
  const index = state.tabs.findIndex((tab) => tab.id === id)
  const tabs = state.tabs.filter((tab) => tab.id !== id)
  if (state.activeTabId !== id) return { ...state, tabs }
  const before = tabs.slice(0, index).reverse().find((tab) => !isFixedView(tab.kind))
  const after = tabs.slice(index).find((tab) => !isFixedView(tab.kind))
  const home = tabs.find((tab) => tab.id === HOME_TAB_ID)
  const next = before ?? after ?? home ?? tabs[0]
  return { ...state, tabs, activeTabId: next ? next.id : HOME_TAB_ID }
}

export function activeWorkbenchTab(state: WorkbenchState): WorkbenchTab | undefined {
  return state.tabs.find((tab) => tab.id === state.activeTabId)
}

export function activeWorkbenchView(state: WorkbenchState): WorkbenchView | null {
  return activeWorkbenchTab(state)?.kind ?? null
}

export function viewFromWorkbench(state: WorkbenchState, available: Set<WorkbenchView>): WorkbenchView {
  const active = activeWorkbenchTab(state)
  if (active && available.has(active.kind)) return active.kind
  const home = state.tabs.find((tab) => tab.id === HOME_TAB_ID)
  if (home && available.has(home.kind)) return home.kind
  const fixed = state.tabs.find((tab) => isFixedView(tab.kind) && available.has(tab.kind))
  return fixed?.kind ?? 'start'
}

export function reconcileWorkbench(state: WorkbenchState, available: Set<WorkbenchView>): WorkbenchState {
  const active = activeWorkbenchTab(state)
  if (active && available.has(active.kind)) return state
  return { ...state, activeTabId: resourceTabId(viewFromWorkbench(state, available)) }
}

export function workbenchSessionKey(sessionFile?: string, sessionId?: string): string {
  return sessionFile || sessionId || PENDING_SESSION_KEY
}

export function pickWorkbenchState(
  map: Record<string, unknown>,
  key: string
): { state: WorkbenchState; consumedPending: boolean } {
  if (Object.prototype.hasOwnProperty.call(map, key) && map[key] !== undefined) {
    return { state: normalizeWorkbenchState(map[key]), consumedPending: false }
  }
  if (key !== PENDING_SESSION_KEY && map[PENDING_SESSION_KEY] !== undefined) {
    return { state: normalizeWorkbenchState(map[PENDING_SESSION_KEY]), consumedPending: true }
  }
  return { state: defaultWorkbenchState(), consumedPending: false }
}

export interface WorkbenchOpenRequest {
  requestId: number
  sessionKey: string
}

export function newWorkbenchOpenRequest(sessionKey: string, previousId = 0): WorkbenchOpenRequest {
  return { requestId: previousId + 1, sessionKey }
}

export function isCurrentWorkbenchOpen(
  request: WorkbenchOpenRequest | null,
  sessionKey: string,
  currentRequestId: number
): boolean {
  return !!request && request.sessionKey === sessionKey && request.requestId === currentRequestId
}

function readMap(): Record<string, unknown> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function writeMap(map: Record<string, unknown>): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
  }
}

export function loadWorkbenchState(key: string): WorkbenchState {
  const map = readMap()
  const picked = pickWorkbenchState(map, key)
  if (picked.consumedPending) {
    delete map[PENDING_SESSION_KEY]
    map[key] = picked.state
    writeMap(map)
  }
  return picked.state
}

export function saveWorkbenchState(key: string, state: WorkbenchState): void {
  const map = readMap()
  map[key] = normalizeWorkbenchState(state)
  writeMap(map)
}
