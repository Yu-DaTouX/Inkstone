import { pick } from '../../shared/ui-lang'
import { ipcMain } from 'electron'
import { humanizeSystemError } from '../../shared/system-error'

export interface IpcRegistrar {
  handle<T>(channel: string, fn: (...args: never[]) => Promise<T> | T): void
  rawHandle(channel: string, fn: (event: Electron.IpcMainInvokeEvent, ...args: never[]) => unknown): void
}

function humanized(error: unknown): unknown {
  if (!(error instanceof Error)) return error
  const text = humanizeSystemError(error.message)
  return text ? new Error(text) : error
}

export function createIpcRegistrar(isTrusted: (event: Electron.IpcMainInvokeEvent) => boolean): IpcRegistrar {
  const guard = (event: Electron.IpcMainInvokeEvent): void => {
    if (!isTrusted(event)) throw new Error(pick('拒绝来自非主窗口的 IPC 调用', 'IPC call from a non-main window was rejected'))
  }
  return {
    handle(channel, fn) {
      ipcMain.handle(channel, async (event, ...args) => {
        guard(event)
        try {
          return await fn(...(args as never[]))
        } catch (error) {
          throw humanized(error)
        }
      })
    },
    rawHandle(channel, fn) {
      ipcMain.handle(channel, async (event, ...args) => {
        guard(event)
        try {
          return await fn(event, ...(args as never[]))
        } catch (error) {
          throw humanized(error)
        }
      })
    }
  }
}
