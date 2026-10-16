/**
 * 页签弹出窗的主进程类型契约（v3 · WP-30 弹出）。
 *
 * 只放类型与宿主注入面：窗口工厂、控制器、IPC 三方共用。运行时实现见
 * `pane-popout-controller.ts` / `pane-popout-ipc.ts`。本文件对 Electron 只做
 * `import type`，不产生运行时依赖，能被单测直接编译。
 */
import type { BrowserWindow, WebContents } from 'electron'
import type {
  PaneActionEvent,
  PaneActionRequest,
  PaneActionResult,
  PaneBrowserStateView,
  PaneNativeTransferAdapter,
  PanePopoutAnyTabId,
  PanePopoutLocale,
  PanePopoutOpenRequest,
  PanePopoutOpenResult,
  PanePopoutTabId,
  PaneProjectionEnvelope,
  PaneStateView
} from '../../shared/pane-popout'
import type { Rect } from './geometry'
import type { PaneBrowserTransfer } from './pane-browser-transfer'

/**
 * 弹出窗需要的宿主事实。与 `AuxHost` 同一来源（主窗口边界、工作区、缩放），
 * 控制器不直接读设置或窗口注册表。
 */
export interface PanePopoutHost {
  /** aux / 弹出的共用 preload。 */
  preloadPath(): string
  /** 在窗口上加载渲染端入口（dev URL 或打包后的 html）。 */
  loadEntry(win: BrowserWindow, entry: 'pane'): void
  /** 主窗口边界；没有主窗口 / 已销毁时 undefined。 */
  anchorBounds(): Rect | undefined
  /** 给定边界落在哪个显示器的工作区。 */
  workArea(bounds: Rect): Rect
  /** 跟随主窗口的界面缩放。 */
  zoomFactor(): number
  locale(): PanePopoutLocale
}

export interface PanePopoutWindowDeps {
  preloadPath: string
  load(win: BrowserWindow): void
  anchorBounds(): Rect | undefined
  workArea(bounds: Rect): Rect
  zoomFactor(): number
  /** 窗口被用户关闭时通知控制器回收会话；不要在里面再 destroy。 */
  onClosed?(): void
}

export interface PanePopoutWindow {
  show(): void
  hide(): void
  isVisible(): boolean
  browserWindow(): BrowserWindow | null
  webContents(): WebContents | null
  send(channel: string, payload: unknown): void
  setTitle(title: string): void
  destroy(): void
}

export type PanePopoutWindowFactory = (deps: PanePopoutWindowDeps) => PanePopoutWindow

/** 主进程校验动作后回投主窗口；`onAction` 是唯一出口，控制器不自己执行渲染端动作。 */
export type PanePopoutActionSink = (event: PaneActionEvent) => void

/**
 * 原生页签 transfer 的可选生命周期（终端适配器已实现）。控制器在 owner 失效时
 * 转发同一条归属失效，避免弹窗 lease 继续持有旧归属。
 */
export interface PaneNativeTransferLifecycle {
  invalidate?(ownerKey: string, reason?: string): void
  invalidateAll?(reason?: string): void
}

/** 控制器接受的原生 transfer 端口：契约 + 可选生命周期。 */
export type PaneNativeTransferPort = PaneNativeTransferAdapter & PaneNativeTransferLifecycle

export interface PanePopoutControllerOptions {
  /** 测试可注入替身；缺省用真实的 `createPanePopoutWindow`。 */
  createWindow?: PanePopoutWindowFactory
  onAction?: PanePopoutActionSink
  /** 额外的宿主授权；返回 false 直接拒绝，缺省放行 matrix 允许的动作。 */
  authorize?(event: PaneActionEvent, action: PaneActionRequest): boolean
  /** 浏览器页签的原生视图转移端口（W3B）。缺省时 browser 弹出按 unsupported 拒绝。 */
  browserTransfer?: PaneBrowserTransfer
  /** 终端页签的同 PTY transfer 端口（W3T）。缺省时 terminal 弹出按 unsupported 拒绝。 */
  terminalTransfer?: PaneNativeTransferPort
}

export interface PanePopoutController {
  /**
   * 打开（或复用）一个页签弹窗。DOM-only 页签按矩阵直接建窗；browser / terminal
   * 交给注入的 transfer 适配器（缺省时返回 `unsupported` 且**不创建窗口**）。
   */
  open(request: PanePopoutOpenRequest): PanePopoutOpenResult
  /** 主窗口推送受限投影；`ownerKey` / `epoch` 不匹配返回 false 并丢弃。 */
  updateProjection(envelope: PaneProjectionEnvelope): boolean
  /** owner 失效：进入不可操作态并释放投影数据，不关闭窗口。 */
  invalidate(ownerKey: string, reason?: string): void
  invalidateAll(reason?: string): void
  close(tab: PanePopoutAnyTabId): void
  closeByContents(contents: WebContents): boolean
  closeAll(): void
  isOpen(tab: PanePopoutAnyTabId): boolean
  openTabs(): PanePopoutTabId[]
  ownerKeyOf(tab: PanePopoutTabId): string | null
  epochOf(tab: PanePopoutTabId): number | null
  stateFor(contents: WebContents): PaneStateView | null
  handleAction(contents: WebContents, action: PaneActionRequest): PaneActionResult
  /** 该 webContents 是否属于某个弹出窗（IPC 来源校验）。 */
  owns(contents: WebContents): boolean
  /** 浏览器原生弹出窗的状态；来源不是浏览器弹窗时 null。 */
  browserStateFor(contents: WebContents): PaneBrowserStateView | null
  /** 该 webContents 是否是某个浏览器弹窗的目标窗口（受限浏览器 IPC 校验）。 */
  ownsBrowser(contents: WebContents): boolean
  dispose(): void
}

/** `pane-popout-ipc.ts` 需要的宿主判定：主窗口与弹出窗的来源区分。 */
export interface PanePopoutIpcHost {
  isMainWindow(contents: WebContents): boolean
}
