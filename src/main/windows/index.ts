/**
 * 辅助小窗模块入口（v3 WP-25d 快速提问 + WP-12 迷你小窗）。
 *
 * 主进程接线只 import 这里：`createAuxWindows(host)` 建立窗口与全局快捷键，
 * `registerAuxIpc(aux)` 注册 `yan:aux:*`。纯逻辑（几何 / 状态 / 注意力投影 /
 * 发送）单独导出，供 scripts/test-v3-aux-windows.mjs 在不启动 Electron 的情况下回归。
 */
export { createAuxWindows } from './aux-controller'
export type { AuxHost, AuxWindows } from './aux-controller'
export { registerAuxIpc } from './aux-ipc'
export { createQuickAskWindow } from './quick-ask-window'
export type { QuickAskWindow, QuickAskWindowDeps } from './quick-ask-window'
export { createMiniWindow } from './mini-window'
export type { MiniWindow, MiniWindowDeps } from './mini-window'
export { attentionItems } from './attention-items'
export { submitQuickAsk } from './quick-ask-submit'
export type { QuickAskAgentPort, QuickAskSubmitDeps } from './quick-ask-submit'
export {
  AUX_MARGIN,
  MINI_SIZE,
  QUICK_ASK_SIZE,
  clampToArea,
  computeMiniBounds,
  computeQuickAskBounds
} from './geometry'
export type { Rect, Size } from './geometry'
export {
  INITIAL_MINI_STATE,
  INITIAL_QUICK_ASK_STATE,
  miniReducer,
  miniWindowHeight,
  quickAskReducer,
  validateQuickAsk
} from './aux-state'
export type { MiniAction, MiniWindowState, QuickAskAction, QuickAskWindowState } from './aux-state'
export type {
  AuxLocale,
  AuxModelOption,
  AuxProjectOption,
  AuxPush,
  AuxSessionRef,
  AuxTarget,
  MiniItem,
  MiniStateView,
  MiniStatusKey,
  QuickAskErrorCode,
  QuickAskResult,
  QuickAskStateView,
  QuickAskSubmit
} from './aux-types'

export { createPanePopoutController, createPanePopoutWindow } from './pane-popout-controller'
export type {
  PanePopoutActionSink,
  PanePopoutController,
  PanePopoutControllerOptions,
  PanePopoutHost,
  PanePopoutIpcHost,
  PanePopoutWindow,
  PanePopoutWindowDeps,
  PanePopoutWindowFactory
} from './pane-popout-types'
export { registerPanePopoutIpc } from './pane-popout-ipc'
export { PANE_POPOUT_MARGIN, PANE_POPOUT_SIZE, PANE_POPOUT_STAGGER, computePanePopoutBounds } from './pane-popout-geometry'

export {
  createPaneBrowserTransfer,
  createPaneBrowserTransferAdapter,
  normalizeTransferBounds
} from './pane-browser-transfer'
export type {
  BrowserHostTransferBridge,
  BrowserHostTransferHandle,
  BrowserLeaseInvalidReason,
  BrowserLeaseResult,
  BrowserLeaseSender,
  BrowserPaneLease,
  BrowserTransferView,
  BrowserTransferWindow,
  PaneBrowserTransfer,
  PaneBrowserTransferAdapter,
  PaneBrowserTransferAdapterOptions,
  PaneBrowserTransferBeginRequest
} from './pane-browser-transfer'
export { registerPaneBrowserIpc } from './pane-browser-ipc'
export type { PaneBrowserIpcDeps } from './pane-browser-ipc'

export { createPaneTerminalTransfer, registerPaneTerminalIpc } from './pane-terminal-transfer'
export type {
  PaneTerminalEvent,
  PaneTerminalIpcHost,
  PaneTerminalLeaseChange,
  PaneTerminalTransfer,
  PaneTerminalTransferHost,
  PaneTerminalTransferOptions,
  PaneTerminalWindowFactory
} from './pane-terminal-transfer'
