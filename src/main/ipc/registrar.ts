import { ipcMain } from 'electron'

export interface IpcRegistrar {
  handle<T>(channel: string, fn: (...args: never[]) => Promise<T> | T): void
  rawHandle(channel: string, fn: (event: Electron.IpcMainInvokeEvent, ...args: never[]) => unknown): void
}

export function createIpcRegistrar(isTrusted: (event: Electron.IpcMainInvokeEvent) => boolean): IpcRegistrar {
  const guard = (event: Electron.IpcMainInvokeEvent): void => {
    if (!isTrusted(event)) throw new Error('拒绝来自非主窗口的 IPC 调用')
  }
  return {
    handle(channel, fn) {
      ipcMain.handle(channel, async (event, ...args) => {
        guard(event)
        return fn(...(args as never[]))
      })
    },
    rawHandle(channel, fn) {
      ipcMain.handle(channel, async (event, ...args) => {
        guard(event)
        return fn(event, ...(args as never[]))
      })
    }
  }
}
