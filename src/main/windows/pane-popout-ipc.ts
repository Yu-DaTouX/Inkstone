import { ipcMain } from 'electron'
import type { WebContents } from 'electron'
import { PANE_POPOUT_CHANNELS, isPanePopoutAnyTab } from '../../shared/pane-popout'
import type { PanePopoutController, PanePopoutIpcHost } from './pane-popout-types'

function isActionShape(value: unknown): value is { type: string; path?: string } {
  return !!value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string'
}

export function registerPanePopoutIpc(controller: PanePopoutController, host: PanePopoutIpcHost): void {
  ipcMain.handle(PANE_POPOUT_CHANNELS.open, (event, request: unknown) => {
    if (!host.isMainWindow(event.sender)) throw new Error('拒绝来自非主窗口的弹出请求')
    if (!request || typeof request !== 'object' || !isPanePopoutAnyTab((request as { tab?: unknown }).tab)) {
      return { ok: false, code: 'rejected', reason: '请求不合法' }
    }
    return controller.open(request as Parameters<PanePopoutController['open']>[0])
  })

  ipcMain.on(PANE_POPOUT_CHANNELS.update, (event, envelope: unknown) => {
    if (!host.isMainWindow(event.sender)) return
    if (!envelope || typeof envelope !== 'object') return
    controller.updateProjection(envelope as Parameters<PanePopoutController['updateProjection']>[0])
  })

  ipcMain.on(PANE_POPOUT_CHANNELS.close, (event, tab: unknown) => {
    if (!host.isMainWindow(event.sender)) return
    if (isPanePopoutAnyTab(tab)) controller.close(tab)
  })

  ipcMain.handle(PANE_POPOUT_CHANNELS.state, (event: { sender: WebContents }) => {
    if (!controller.owns(event.sender)) throw new Error('拒绝来自非弹出窗的 IPC 调用')
    return controller.stateFor(event.sender)
  })

  ipcMain.handle(PANE_POPOUT_CHANNELS.action, (event: { sender: WebContents }, action: unknown) => {
    if (!controller.owns(event.sender)) return { ok: false, code: 'rejected', message: '来源不是弹出窗' }
    if (!isActionShape(action)) return { ok: false, code: 'rejected', message: '动作不合法' }
    return controller.handleAction(event.sender, action as Parameters<PanePopoutController['handleAction']>[1])
  })

  ipcMain.on(PANE_POPOUT_CHANNELS.closeSelf, (event) => {
    if (controller.owns(event.sender)) controller.closeByContents(event.sender)
  })
}
