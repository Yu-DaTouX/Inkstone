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
  open(request: PanePopoutOpenRequest): Promise<PanePopoutOpenResult>
  update(envelope: PaneProjectionEnvelope): void
  close(tab: PanePopoutAnyTabId): void

  state(): Promise<PaneStateView | null>
  action(action: PaneActionRequest): Promise<PaneActionResult>
  closeSelf(): void

  onPush(cb: (view: PaneStateView) => void): () => void
  onAction(cb: (event: PaneActionEvent) => void): () => void
}

export interface PaneBrowserLeaseResult {
  ok: boolean
  code: string
  message?: string
}

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

export function panePopoutBridge(): PanePopoutBridge | null {
  return (window as unknown as { paneBridge?: PanePopoutBridge }).paneBridge ?? null
}

export function paneBrowserBridge(): PaneBrowserBridge | null {
  return (window as unknown as { paneBrowserBridge?: PaneBrowserBridge }).paneBrowserBridge ?? null
}

export function paneTerminalBridge(): PaneTerminalBridge | null {
  return (window as unknown as { paneTerminalBridge?: PaneTerminalBridge }).paneTerminalBridge ?? null
}
