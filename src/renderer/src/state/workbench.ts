/**
 * 右栏工作窗口的布局与资源状态（实施-11 H-3a）。
 *
 * 资源本身仍由浏览器 / 文件 / 子代理各自的 owner 管理；这里只保存
 * 用户可恢复的标签与布局，不把 Cookie、凭证或会话正文复制进第二份真源。
 *
 * H-3a 冻结的契约：
 *   · `version` 显式分支：只认 1 / 2。未知（未来或脏）版本只保留宽度与展开，
 *     资源回固定导航页，不把读不懂的布局硬塞进当前渲染器。
 *   · 资源身份与渲染 kind 分离：`id` 是唯一身份（`kind:resourceKey`），
 *     `kind` 只决定用哪个渲染器。同名不同根的文档、两个子代理不会撞 id。
 *   · `start` / `tools` 是固定导航页：没有资源身份、不可关闭。
 *   · 布局按**稳定会话**隔离（`workbenchSessionKey`）；临时 `pending` 布局只被
 *     一个真实会话采用一次，不共享给其它会话（`pickWorkbenchState`）。
 *   · 异步打开用 `WorkbenchOpenRequest`（requestId + sessionKey）校验，
 *     迟到的返回不写进已切换的会话（`isCurrentWorkbenchOpen`）。
 */
export type WorkbenchView = 'start' | 'tools' | 'review' | 'browser' | 'file' | 'subagent'

/** 需要真实资源身份、可关闭的页面 */
export type WorkbenchResourceView = Exclude<WorkbenchView, 'start' | 'tools'>

export interface WorkbenchTab {
  /** 唯一身份；固定页就是 kind，资源页是 `kind:resourceKey` */
  id: string
  /** 只决定渲染器 */
  kind: WorkbenchView
  /** 资源身份（文件 canonicalPath / 子代理 runId / 浏览器 page / 审查对象） */
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

/** 临时会话（还没有稳定 sessionFile/sessionId）的布局身份 */
export const PENDING_SESSION_KEY = 'pending'

/** 默认首页：新会话从开始页起，关闭最后一个资源也回到它 */
export const HOME_TAB_ID = 'start'

const STORAGE_KEY = 'yan.workbench.v1'
const CURRENT_VERSION = 2
const VIEWS: readonly WorkbenchView[] = ['start', 'tools', 'review', 'browser', 'file', 'subagent']
const FIXED_VIEWS = new Set<WorkbenchView>(['start', 'tools'])

function isView(value: unknown): value is WorkbenchView {
  return typeof value === 'string' && (VIEWS as readonly string[]).includes(value)
}

/** 固定导航页不可关闭（关闭请求是 no-op，只把活动页指回它自己） */
export function isFixedView(kind: WorkbenchView): boolean {
  return FIXED_VIEWS.has(kind)
}

/** 由 kind + 资源身份构造唯一标签 id；没有资源身份时就是 kind */
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
    return [{
      id: item.id,
      kind: item.kind,
      ...(typeof item.resourceKey === 'string' ? { resourceKey: item.resourceKey } : {}),
      ...(typeof item.title === 'string' ? { title: item.title } : {})
    }]
  })
  /* 同 id 只保留第一份：重复标签不能让同一资源挂两份订阅 */
  return tabs.filter((tab, index) => tabs.findIndex((candidate) => candidate.id === tab.id) === index)
}

/**
 * 归一化任意输入。**版本必须显式分支**：
 *   · 1 / 2 → 结构兼容，清洗标签后按当前版本存；
 *   · 其它（未来版本、字符串版本、脏值）→ 只保宽度/展开，资源回固定页。
 */
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
  /* 固定导航页始终存在：开始页在前，工具页在后 */
  if (!tabs.some((tab) => tab.id === HOME_TAB_ID)) tabs.unshift({ id: HOME_TAB_ID, kind: 'start', title: '开始' })
  if (!tabs.some((tab) => tab.id === 'tools')) tabs.push({ id: 'tools', kind: 'tools', title: '工具' })
  const activeTabId = typeof input.activeTabId === 'string' && tabs.some((tab) => tab.id === input.activeTabId)
    ? input.activeTabId
    : HOME_TAB_ID
  return { version: CURRENT_VERSION, tabs, activeTabId, width, expanded }
}

/** 打开（或复用）一个资源标签并设为活动页 */
export function activateWorkbenchTab(state: WorkbenchState, kind: WorkbenchView, resourceKey?: string): WorkbenchState {
  const id = resourceTabId(kind, resourceKey)
  const existing = state.tabs.find((tab) => tab.id === id)
  const tabs = existing ? state.tabs : [...state.tabs, { id, kind, ...(resourceKey ? { resourceKey } : {}) }]
  return { ...state, tabs, activeTabId: id }
}

/**
 * 关闭一个标签。固定页不可关闭；关闭活动页时回到它**在顺序里的前一个**可用标签
 * （没有则取后一个，再没有就回工具页），不跳到无关资源。
 */
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
  /* 优先回顺序里的前一个「资源」；没有资源就回开始页（不是工具页） */
  const before = tabs.slice(0, index).reverse().find((tab) => !isFixedView(tab.kind))
  const after = tabs.slice(index).find((tab) => !isFixedView(tab.kind))
  const home = tabs.find((tab) => tab.id === HOME_TAB_ID)
  const next = before ?? after ?? home ?? tabs[0]
  return { ...state, tabs, activeTabId: next ? next.id : HOME_TAB_ID }
}

/** 活动标签（唯一真源） */
export function activeWorkbenchTab(state: WorkbenchState): WorkbenchTab | undefined {
  return state.tabs.find((tab) => tab.id === state.activeTabId)
}

/** 活动页渲染 kind；以活动标签为真源，不用另一份本地视图状态 */
export function activeWorkbenchView(state: WorkbenchState): WorkbenchView | null {
  return activeWorkbenchTab(state)?.kind ?? null
}

/**
 * 恢复时用：活动资源的 kind 不在可用集合里就退到可用标签，
 * 不伪造一个打不开的页面。运行时的异步打开不走这里（用 open request 守卫）。
 */
export function viewFromWorkbench(state: WorkbenchState, available: Set<WorkbenchView>): WorkbenchView {
  const active = activeWorkbenchTab(state)
  if (active && available.has(active.kind)) return active.kind
  const home = state.tabs.find((tab) => tab.id === HOME_TAB_ID)
  if (home && available.has(home.kind)) return home.kind
  const fixed = state.tabs.find((tab) => isFixedView(tab.kind) && available.has(tab.kind))
  return fixed?.kind ?? 'start'
}

/** 载入/切会话时把不可用活动资源对到可用标签，返回修正后的状态 */
export function reconcileWorkbench(state: WorkbenchState, available: Set<WorkbenchView>): WorkbenchState {
  const active = activeWorkbenchTab(state)
  if (active && available.has(active.kind)) return state
  return { ...state, activeTabId: resourceTabId(viewFromWorkbench(state, available)) }
}

/* ── 布局身份与迁移 ───────────────────────────────────────────── */

export function workbenchSessionKey(sessionFile?: string, sessionId?: string): string {
  return sessionFile || sessionId || PENDING_SESSION_KEY
}

/**
 * 从存储映射里选出该会话的布局（纯函数，便于测试）。
 *
 * `consumedPending` 为真表示：这是真实会话且它自己没有已保存布局，
 * 采用了唯一的临时布局，调用方应把 pending 删除，避免第二个会话再拿一次。
 */
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

/* ── 异步打开守卫 ─────────────────────────────────────────────── */

export interface WorkbenchOpenRequest {
  /** 递增序号：同一个会话里后发的请求作废先发的 */
  requestId: number
  /** 发起请求时的布局身份 */
  sessionKey: string
}

export function newWorkbenchOpenRequest(sessionKey: string, previousId = 0): WorkbenchOpenRequest {
  return { requestId: previousId + 1, sessionKey }
}

/** 迟到的打开回调只有在身份与序号都还当前时才允许写状态 */
export function isCurrentWorkbenchOpen(
  request: WorkbenchOpenRequest | null,
  sessionKey: string,
  currentRequestId: number
): boolean {
  return !!request && request.sessionKey === sessionKey && request.requestId === currentRequestId
}

/* ── 存储读写 ─────────────────────────────────────────────────── */

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
    /* 布局偏好写失败不影响资源与会话 */
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
