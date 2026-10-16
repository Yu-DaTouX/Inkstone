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

export interface PanePopoutHost {
  preloadPath(): string
  loadEntry(win: BrowserWindow, entry: 'pane'): void
  anchorBounds(): Rect | undefined
  workArea(bounds: Rect): Rect
  zoomFactor(): number
  locale(): PanePopoutLocale
}

export interface PanePopoutWindowDeps {
  preloadPath: string
  load(win: BrowserWindow): void
  anchorBounds(): Rect | undefined
  workArea(bounds: Rect): Rect
  zoomFactor(): number
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

export type PanePopoutActionSink = (event: PaneActionEvent) => void

export interface PaneNativeTransferLifecycle {
  invalidate?(ownerKey: string, reason?: string): void
  invalidateAll?(reason?: string): void
}

export type PaneNativeTransferPort = PaneNativeTransferAdapter & PaneNativeTransferLifecycle

export interface PanePopoutControllerOptions {
  createWindow?: PanePopoutWindowFactory
  onAction?: PanePopoutActionSink
  authorize?(event: PaneActionEvent, action: PaneActionRequest): boolean
  browserTransfer?: PaneBrowserTransfer
  terminalTransfer?: PaneNativeTransferPort
}

export interface PanePopoutController {
  open(request: PanePopoutOpenRequest): PanePopoutOpenResult
  updateProjection(envelope: PaneProjectionEnvelope): boolean
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
  owns(contents: WebContents): boolean
  browserStateFor(contents: WebContents): PaneBrowserStateView | null
  ownsBrowser(contents: WebContents): boolean
  dispose(): void
}

export interface PanePopoutIpcHost {
  isMainWindow(contents: WebContents): boolean
}
