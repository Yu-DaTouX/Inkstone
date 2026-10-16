/**
 * 页签弹出窗的渲染端桥（v3 · WP-30 弹出）。
 *
 * 与 `aux-bridge.ts` 同构：preload 通过 `contextBridge.exposeInMainWorld('paneBridge', …)`
 * 暴露白名单方法。弹出页与主窗口共用这份 preload，所以桥同时含两侧动作；真正
 * 的来源区分在主进程 `pane-popout-ipc.ts`。这里只声明形状，不 import 主进程模块。
 *
 * 原生页签另有两份受限桥：`paneBrowserBridge`（借出的 WebContentsView）与
 * `paneTerminalBridge`（同 PTY lease）。两者都只声明形状、只读 window 全局，
 * 不把主进程的通用 IPC 面带进渲染端。
 */
import type {
  PaneActionEvent,
  PaneActionRequest,
  PaneActionResult,
  PaneBrowserStateView,
  PanePopoutAnyTabId,
  PanePopoutOpenRequest,
  PanePopoutOpenResult,
  PaneProjectionEnvelope,
  PaneStateView
} from '../../shared/pane-popout'
import type { PaneTerminalBridge } from '../../shared/pane-terminal'

export interface PanePopoutBridge {
  /* 主窗口侧 */
  open(request: PanePopoutOpenRequest): Promise<PanePopoutOpenResult>
  update(envelope: PaneProjectionEnvelope): void
  close(tab: PanePopoutAnyTabId): void

  /* 弹出窗侧 */
  state(): Promise<PaneStateView | null>
  action(action: PaneActionRequest): Promise<PaneActionResult>
  closeSelf(): void

  /** 弹出窗订阅宿主推送的状态视图。 */
  onPush(cb: (view: PaneStateView) => void): () => void
  /** 主窗口订阅弹出窗触发的动作（已带 ownerKey / epoch）。 */
  onAction(cb: (event: PaneActionEvent) => void): () => void
}

/** 与主进程 `BrowserLeaseResult` 同形的受限结果；渲染端只判断 ok / code。 */
export interface PaneBrowserLeaseResult {
  ok: boolean
  code: string
  message?: string
}

/**
 * 浏览器原生弹出窗的受限桥。形状与 preload 的 `paneBrowserApi` 一致；
 * 端口收 DIP，渲染端负责把 CSS 像素换算成 DIP 后再发。
 */
export interface PaneBrowserBridge {
  state(): Promise<PaneBrowserStateView | null>
  setBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<PaneBrowserLeaseResult>
  navigate(url: string): Promise<PaneBrowserLeaseResult>
  goBack(): Promise<PaneBrowserLeaseResult>
  goForward(): Promise<PaneBrowserLeaseResult>
  reload(): Promise<PaneBrowserLeaseResult>
  close(): Promise<PaneBrowserLeaseResult>
  returnToHost(): Promise<PaneBrowserLeaseResult>
}

/** 取 preload 暴露的 `paneBridge`；独立打开 html 调试时可能不存在。 */
export function panePopoutBridge(): PanePopoutBridge | null {
  return (window as unknown as { paneBridge?: PanePopoutBridge }).paneBridge ?? null
}

/** 取 preload 暴露的 `paneBrowserBridge`；非浏览器弹窗 / 调试时可能不存在。 */
export function paneBrowserBridge(): PaneBrowserBridge | null {
  return (window as unknown as { paneBrowserBridge?: PaneBrowserBridge }).paneBrowserBridge ?? null
}

/** 取 preload 暴露的 `paneTerminalBridge`；非终端弹窗 / 调试时可能不存在。 */
export function paneTerminalBridge(): PaneTerminalBridge | null {
  return (window as unknown as { paneTerminalBridge?: PaneTerminalBridge }).paneTerminalBridge ?? null
}
