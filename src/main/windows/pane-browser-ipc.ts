import { ipcMain } from 'electron'
import type { WebContents } from 'electron'
import { PANE_BROWSER_CHANNELS, type PaneBrowserStateView } from '../../shared/pane-popout'
import type { PanePopoutController } from './pane-popout-types'
import type { PaneBrowserTransfer } from './pane-browser-transfer'

export interface PaneBrowserIpcDeps {
  controller: PanePopoutController
  transfer: PaneBrowserTransfer
}

function isBounds(value: unknown): value is { x: number; y: number; width: number; height: number } {
  if (!value || typeof value !== 'object') return false
  const bounds = value as Record<string, unknown>
  return [bounds.x, bounds.y, bounds.width, bounds.height].every(
    (item) => typeof item === 'number' && Number.isFinite(item)
  )
}

export function registerPaneBrowserIpc(deps: PaneBrowserIpcDeps): void {
  const { controller, transfer } = deps

  ipcMain.handle(PANE_BROWSER_CHANNELS.state, (event: { sender: WebContents }) => {
    if (!controller.ownsBrowser(event.sender)) throw new Error('拒绝来自非浏览器弹窗的 IPC 调用')
    return controller.browserStateFor(event.sender)
  })

  ipcMain.handle(PANE_BROWSER_CHANNELS.bounds, (event: { sender: WebContents }, bounds: unknown) => {
    if (!controller.ownsBrowser(event.sender)) return { ok: false, code: 'rejected', message: '来源不是浏览器弹窗' }
    if (!isBounds(bounds)) return { ok: false, code: 'rejected', message: '坐标不合法' }
    return transfer.updateBounds({ webContentsId: event.sender.id }, bounds)
  })

  ipcMain.handle(PANE_BROWSER_CHANNELS.navigate, (event: { sender: WebContents }, url: unknown) => {
    if (!controller.ownsBrowser(event.sender)) return { ok: false, code: 'rejected', message: '来源不是浏览器弹窗' }
    return transfer.navigate({ webContentsId: event.sender.id }, typeof url === 'string' ? url : '')
  })

  ipcMain.handle(PANE_BROWSER_CHANNELS.back, (event: { sender: WebContents }) => {
    if (!controller.ownsBrowser(event.sender)) return { ok: false, code: 'rejected', message: '来源不是浏览器弹窗' }
    return transfer.goBack({ webContentsId: event.sender.id })
  })

  ipcMain.handle(PANE_BROWSER_CHANNELS.forward, (event: { sender: WebContents }) => {
    if (!controller.ownsBrowser(event.sender)) return { ok: false, code: 'rejected', message: '来源不是浏览器弹窗' }
    return transfer.goForward({ webContentsId: event.sender.id })
  })

  ipcMain.handle(PANE_BROWSER_CHANNELS.reload, (event: { sender: WebContents }) => {
    if (!controller.ownsBrowser(event.sender)) return { ok: false, code: 'rejected', message: '来源不是浏览器弹窗' }
    return transfer.reload({ webContentsId: event.sender.id })
  })

  ipcMain.handle(PANE_BROWSER_CHANNELS.close, async (event: { sender: WebContents }) => {
    if (!controller.ownsBrowser(event.sender)) return { ok: false, code: 'rejected', message: '来源不是浏览器弹窗' }
    const result = await transfer.close({ webContentsId: event.sender.id })
    controller.closeByContents(event.sender)
    return result
  })

  ipcMain.handle(PANE_BROWSER_CHANNELS.returnToHost, (event: { sender: WebContents }) => {
    if (!controller.ownsBrowser(event.sender)) return { ok: false, code: 'rejected', message: '来源不是浏览器弹窗' }
    const result = transfer.returnToHost({ webContentsId: event.sender.id })
    controller.closeByContents(event.sender)
    return result
  })
}

export type { PaneBrowserStateView }
