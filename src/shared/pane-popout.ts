/**
 * 工作区页签独立窗口（弹出窗）的跨进程契约（v3 · WP-30 弹出）。
 *
 * 纯类型与纯判定，不 import Electron、不 import DOM，主进程控制器、渲染端
 * 弹出页与主窗口客户端共用这一份形状，可直接在 node 里编译单测。
 *
 * 边界（DOM-only 只读投影 + 原生页签 transfer）：
 *   · `files / changes / context / branch` 的弹出是「主窗口把受限投影交给
 *     主进程，主进程再推给独立窗口」，弹出页**不读主窗口 store、不直接调通用
 *     IPC**；窗口在打开时锁定 `PanePopoutOwner`，迟到投影按 `ownerKey + epoch`
 *     丢弃。
 *   · `browser` 已接入原生视图转移：适配器把**同一个** `WebContentsView` 从主窗口
 *     contentView 改挂到独立窗口，不重建、不重新 loadURL（见
 *     `main/windows/pane-browser-transfer.ts`）；弹出窗只经受限端口动这一个视图。
 *   · `terminal` 走自己的同 PTY 契约（`shared/pane-terminal.ts` + `main/windows/
 *     pane-terminal-transfer.ts`）：只 attach 既有 PTY，不 start / kill；控制器通过
 *     注入的 transfer 端口转发，带 `terminalId` 时开窗，不再一律拒绝。
 *   · `preview` 仍需 iframe 迁移，矩阵标记 `unsupported`（见
 *     `PANE_TRANSFER_MATRIX` 与 `PANE_NATIVE_TRANSFER_FOLLOW_UP`），控制器拒绝打开，
 *     不画假可用按钮。
 */

/** 弹出页与宿主共用的语言字面量；与 i18n 的 `Lang` 同形，不引入运行时。 */
export type PanePopoutLocale = 'zh-CN' | 'en-US'

/** 本批可弹出的 DOM-only 只读页签。 */
export type PanePopoutTabId = 'files' | 'changes' | 'context' | 'branch'

/** 需要原生资源 transfer 才能弹出的页签；本批不支持。 */
export type PaneNativeTabId = 'browser' | 'terminal' | 'preview'

export type PanePopoutAnyTabId = PanePopoutTabId | PaneNativeTabId

/** 资源进入第二窗口的方式。 */
export type PaneTransferKind = 'dom-projection' | 'native-view' | 'terminal-attach' | 'iframe'

export type PaneTransferSupport = 'supported' | 'unsupported'

export interface PaneTransferDescriptor {
  kind: PaneTransferKind
  support: PaneTransferSupport
  /** `unsupported` 时写明真实约束；不是实现承诺。 */
  reason?: string
}

/**
 * 每个页签的 transfer 方式与支持状态。控制器**只据此**决定能否开窗；
 * 渲染端只据此决定按钮是否可用，不各自维护第二份判断。
 */
export const PANE_TRANSFER_MATRIX: Record<PanePopoutAnyTabId, PaneTransferDescriptor> = {
  files: { kind: 'dom-projection', support: 'supported' },
  changes: { kind: 'dom-projection', support: 'supported' },
  context: { kind: 'dom-projection', support: 'supported' },
  branch: { kind: 'dom-projection', support: 'supported' },
  browser: {
    kind: 'native-view',
    support: 'supported'
  },
  terminal: {
    kind: 'terminal-attach',
    support: 'unsupported',
    reason: '终端需要同一 terminalId 在第二窗口 attach，本批没有现成 transfer adapter。'
  },
  preview: {
    kind: 'iframe',
    support: 'unsupported',
    reason: '预览 iframe 动态不可重建，迁移到第二窗口需要重挂载协调，本批不支持。'
  }
}

/** 原生页签后续接入（W3）的最小真实工作清单；用于拒绝时的 followUp。 */
export const PANE_NATIVE_TRANSFER_FOLLOW_UP: readonly string[] = [
  'terminal：按同一 terminalId 在第二窗口 attach，沿用打开时锁定的 owner.cwd；禁止 start / kill，迟到数据按 epoch 丢弃。',
  'preview：把预览 iframe 的宿主从主窗口迁到弹出窗，或由弹出窗重新挂载同一离线 HTML 源（不重建动态内容）。',
  '主进程层：为上述两者各提供 `PaneNativeTransferAdapter`（见本文件），由控制器在 owner 变化时先隐藏再改挂。'
]

/**
 * 工作区归属的镜像形状（与 `features/workbench/types.ts#WorkspaceOwner` 一致）。
 *
 * 这里独立声明而不是 import 渲染端模块：shared 层不依赖 renderer，弹窗渲染端
 * 也不需要主窗口的 store 类型。字段语义与 R0 契约相同，`key` 只表达归属，不是授权。
 */
export interface PanePopoutOwner {
  readonly key: string
  readonly sessionId: string | null
  readonly sessionFile?: string
  readonly cwd: string
  readonly runId?: string
  readonly generation?: number
  readonly active: boolean
}

/* ── 受限投影（主窗口计算、主进程转发、弹出窗只渲染） ───────────────── */

export interface PaneFileRow {
  path: string
  name: string
  dir: boolean
  depth: number
  hidden?: boolean
}

export interface PaneChangeRow {
  path: string
  /** 两位状态码（`M ` / ` M` / `MM` / `??` …）。 */
  status: string
  untracked?: boolean
  staged?: boolean
}

export interface PaneContextSegment {
  id: string
  label: string
  tokens: number
  tone?: 'normal' | 'warn' | 'free'
}

export interface PaneBranchRow {
  id: string
  label: string
  active: boolean
  depth?: number
}

export interface FilesProjection {
  kind: 'files'
  root: string
  rows: PaneFileRow[]
  truncated?: boolean
  note?: string
}

export interface ChangesProjection {
  kind: 'changes'
  repo: string | null
  branch?: string
  rows: PaneChangeRow[]
  note?: string
}

export interface ContextProjection {
  kind: 'context'
  usedTokens: number
  windowTokens: number
  known: boolean
  segments: PaneContextSegment[]
  note?: string
}

export interface BranchProjection {
  kind: 'branch'
  rows: PaneBranchRow[]
  note?: string
}

export type PaneProjection = FilesProjection | ChangesProjection | ContextProjection | BranchProjection

/** 主窗口 → 主进程的投影信封；`ownerKey + epoch` 是迟到丢弃的唯一依据。 */
export interface PaneProjectionEnvelope {
  tab: PanePopoutTabId
  ownerKey: string
  epoch: number
  projection: PaneProjection
}

/* ── 受 owner 限制的操作 ─────────────────────────────────────────────── */

/** 本批允许的动作类型；没有列出的操作在控制器里一律拒绝。 */
export type PaneActionType = 'files.preview' | 'files.attach' | 'refresh'

export interface PaneActionRequest {
  type: PaneActionType
  /** `files.preview` / `files.attach` 需要的绝对路径。 */
  path?: string
}

export interface PaneActionResult {
  ok: boolean
  code?: 'ok' | 'rejected' | 'stale' | 'invalid-owner' | 'unsupported'
  message?: string
}

/** 每个页签允许的动作；界面只据此画按钮，控制器再校验一次。 */
export const PANE_ALLOWED_ACTIONS: Record<PanePopoutTabId, readonly PaneActionType[]> = {
  files: ['files.preview', 'files.attach', 'refresh'],
  changes: ['refresh'],
  context: ['refresh'],
  branch: ['refresh']
}

/** 主进程校验通过后回投给主窗口的动作事件，带 epoch 便于主窗口丢弃过期动作。 */
export interface PaneActionEvent {
  tab: PanePopoutTabId
  ownerKey: string
  epoch: number
  action: PaneActionRequest
}

/* ── 打开请求与状态视图 ────────────────────────────────────────────── */

export interface PanePopoutOpenRequest {
  tab: PanePopoutAnyTabId
  owner: PanePopoutOwner
  locale?: PanePopoutLocale
  /** 原生页签要迁移的资源 id：browser 为浏览器 tabId。 */
  viewId?: string
  /** terminal：要 attach 的既有终端 id（不 start / 不 kill）。 */
  terminalId?: string
}

export interface PanePopoutOpenResult {
  ok: boolean
  code?: 'ok' | 'unsupported' | 'rejected'
  reason?: string
  /** 原生页签被拒时给出的最小后续清单。 */
  followUp?: readonly string[]
  /** 成功时为绑定后的 epoch；主窗口随后推送投影必须带上它。 */
  epoch?: number
}

export interface PaneStateView {
  locale: PanePopoutLocale
  tab: PanePopoutTabId
  owner: PanePopoutOwner
  epoch: number
  transfer: PaneTransferKind
  /** 无可用动作时为 true；弹出页据此只读渲染。 */
  readOnly: boolean
  /** owner 已失效：数据被释放、动作禁用，用户只能关闭。 */
  invalidated: boolean
  invalidReason?: string
  actions: readonly PaneActionType[]
  projection: PaneProjection | null
}

/**
 * 浏览器原生弹出窗的状态视图。
 *
 * 与 DOM 投影弹窗不同：内容不是主窗口推来的投影，而是挂在弹窗 contentView 上的
 * 真实 WebContentsView；这里只告诉弹窗渲染端「它认领的是哪个 tabId、是否已失效」。
 */
export interface PaneBrowserStateView {
  locale: PanePopoutLocale
  tab: 'browser'
  owner: PanePopoutOwner
  epoch: number
  /** 借出的浏览器页签 id（地址栏/工具条用它）。 */
  tabId: string
  /** 原生视图的 webContents id；IPC 用它校验来源。 */
  webContentsId: number
  /** 借出视图当前 URL；取不到时为 ''。 */
  url: string
  /** 历史可用性，工具条据此启用前进 / 后退。 */
  canGoBack: boolean
  canGoForward: boolean
  /** 弹窗 webContents 的缩放倍率；渲染端把 CSS 像素换算成视图 DIP 坐标时用。 */
  zoomFactor: number
  invalidated: boolean
  invalidReason?: string
}

/* ── W3 原生 transfer 契约（browser 已接入；见 pane-browser-transfer.ts） ── */

export interface PaneNativeTransferRequest {
  tab: PaneNativeTabId
  owner: PanePopoutOwner
  /** terminal：要 attach 的终端 id；browser / preview：可选视图 id。 */
  terminalId?: string
  viewId?: string
}

export type PaneTransferResult =
  | { ok: true }
  | { ok: false; code: 'no-adapter' | 'unsupported' | 'rejected'; message: string; followUp: readonly string[] }

/**
 * 原生页签接入边界：只有「同一实例可改挂」或「同一 terminalId 可 attach」时
 * `canTransfer` 才为 true。控制器在实现该 adapter 前不会为原生页签开窗。
 */
export interface PaneNativeTransferAdapter {
  kind: PaneTransferKind
  canTransfer(request: PaneNativeTransferRequest): boolean
  transfer(request: PaneNativeTransferRequest): PaneTransferResult
}

/* ── 通道名与纯判定 ────────────────────────────────────────────────── */

export const PANE_POPOUT_CHANNELS = {
  open: 'yan:pane-popout:open',
  update: 'yan:pane-popout:update',
  close: 'yan:pane-popout:close',
  closeSelf: 'yan:pane-popout:close-self',
  state: 'yan:pane-popout:state',
  action: 'yan:pane-popout:action',
  actionEvent: 'yan:pane-popout:action-event',
  push: 'yan:pane-popout:push'
} as const

/**
 * 浏览器原生弹出窗的受限通道。
 *
 * 弹出窗只能通过这些受限通道动它自己那一个 WebContentsView；主进程按来源窗口
 * 与租约校验，不把通用 `yan:browser:*` 交给 aux。
 */
export const PANE_BROWSER_CHANNELS = {
  state: 'yan:pane-browser:state',
  bounds: 'yan:pane-browser:bounds',
  navigate: 'yan:pane-browser:navigate',
  back: 'yan:pane-browser:back',
  forward: 'yan:pane-browser:forward',
  reload: 'yan:pane-browser:reload',
  close: 'yan:pane-browser:close',
  returnToHost: 'yan:pane-browser:return'
} as const

export function isPanePopoutTab(value: unknown): value is PanePopoutTabId {
  return value === 'files' || value === 'changes' || value === 'context' || value === 'branch'
}

export function isPaneNativeTab(value: unknown): value is PaneNativeTabId {
  return value === 'browser' || value === 'terminal' || value === 'preview'
}

export function isPanePopoutAnyTab(value: unknown): value is PanePopoutAnyTabId {
  return isPanePopoutTab(value) || isPaneNativeTab(value)
}

export function isPopoutSupported(tab: PanePopoutAnyTabId): boolean {
  return PANE_TRANSFER_MATRIX[tab]?.support === 'supported'
}

export function isPaneActionAllowed(tab: PanePopoutTabId, type: PaneActionType): boolean {
  return PANE_ALLOWED_ACTIONS[tab]?.includes(type) ?? false
}
