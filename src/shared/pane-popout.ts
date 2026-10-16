export type PanePopoutLocale = 'zh-CN' | 'en-US'

export type PanePopoutTabId = 'files' | 'changes' | 'context' | 'branch'

export type PaneNativeTabId = 'browser' | 'terminal' | 'preview'

export type PanePopoutAnyTabId = PanePopoutTabId | PaneNativeTabId

export type PaneTransferKind = 'dom-projection' | 'native-view' | 'terminal-attach' | 'iframe'

export type PaneTransferSupport = 'supported' | 'unsupported'

export interface PaneTransferDescriptor {
  kind: PaneTransferKind
  support: PaneTransferSupport
  reason?: string
}

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

export const PANE_NATIVE_TRANSFER_FOLLOW_UP: readonly string[] = [
  'terminal：按同一 terminalId 在第二窗口 attach，沿用打开时锁定的 owner.cwd；禁止 start / kill，迟到数据按 epoch 丢弃。',
  'preview：把预览 iframe 的宿主从主窗口迁到弹出窗，或由弹出窗重新挂载同一离线 HTML 源（不重建动态内容）。',
  '主进程层：为上述两者各提供 `PaneNativeTransferAdapter`（见本文件），由控制器在 owner 变化时先隐藏再改挂。'
]

export interface PanePopoutOwner {
  readonly key: string
  readonly sessionId: string | null
  readonly sessionFile?: string
  readonly cwd: string
  readonly runId?: string
  readonly generation?: number
  readonly active: boolean
}

export interface PaneFileRow {
  path: string
  name: string
  dir: boolean
  depth: number
  hidden?: boolean
}

export interface PaneChangeRow {
  path: string
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

export interface PaneProjectionEnvelope {
  tab: PanePopoutTabId
  ownerKey: string
  epoch: number
  projection: PaneProjection
}

export type PaneActionType = 'files.preview' | 'files.attach' | 'refresh'

export interface PaneActionRequest {
  type: PaneActionType
  path?: string
}

export interface PaneActionResult {
  ok: boolean
  code?: 'ok' | 'rejected' | 'stale' | 'invalid-owner' | 'unsupported'
  message?: string
}

export const PANE_ALLOWED_ACTIONS: Record<PanePopoutTabId, readonly PaneActionType[]> = {
  files: ['files.preview', 'files.attach', 'refresh'],
  changes: ['refresh'],
  context: ['refresh'],
  branch: ['refresh']
}

export interface PaneActionEvent {
  tab: PanePopoutTabId
  ownerKey: string
  epoch: number
  action: PaneActionRequest
}

export interface PanePopoutOpenRequest {
  tab: PanePopoutAnyTabId
  owner: PanePopoutOwner
  locale?: PanePopoutLocale
  viewId?: string
  terminalId?: string
}

export interface PanePopoutOpenResult {
  ok: boolean
  code?: 'ok' | 'unsupported' | 'rejected'
  reason?: string
  followUp?: readonly string[]
  epoch?: number
}

export interface PaneStateView {
  locale: PanePopoutLocale
  tab: PanePopoutTabId
  owner: PanePopoutOwner
  epoch: number
  transfer: PaneTransferKind
  readOnly: boolean
  invalidated: boolean
  invalidReason?: string
  actions: readonly PaneActionType[]
  projection: PaneProjection | null
}

export interface PaneBrowserStateView {
  locale: PanePopoutLocale
  tab: 'browser'
  owner: PanePopoutOwner
  epoch: number
  tabId: string
  webContentsId: number
  url: string
  canGoBack: boolean
  canGoForward: boolean
  zoomFactor: number
  invalidated: boolean
  invalidReason?: string
}

export interface PaneNativeTransferRequest {
  tab: PaneNativeTabId
  owner: PanePopoutOwner
  terminalId?: string
  viewId?: string
}

export type PaneTransferResult =
  | { ok: true }
  | { ok: false; code: 'no-adapter' | 'unsupported' | 'rejected'; message: string; followUp: readonly string[] }

export interface PaneNativeTransferAdapter {
  kind: PaneTransferKind
  canTransfer(request: PaneNativeTransferRequest): boolean
  transfer(request: PaneNativeTransferRequest): PaneTransferResult
}

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
