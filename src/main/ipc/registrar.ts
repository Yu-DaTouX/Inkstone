import { pick } from '../../shared/ui-lang'
import { ipcMain } from 'electron'
import { humanizeSystemError } from '../../shared/system-error'
import type { IpcArgs, IpcChannel, IpcResult } from '../../shared/ipc-channels'

export type IpcHandler<C extends IpcChannel> = (...args: IpcArgs<C>) => IpcResult<C> | Promise<IpcResult<C>>

export type IpcRawHandler<C extends IpcChannel> = (event: Electron.IpcMainInvokeEvent, ...args: IpcArgs<C>) => IpcResult<C> | Promise<IpcResult<C>>

export interface IpcRegistrar {
  handle<C extends IpcChannel>(channel: C, fn: NoInfer<IpcHandler<C>>): void
  rawHandle<C extends IpcChannel>(channel: C, fn: NoInfer<IpcRawHandler<C>>): void
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
      const call = fn as (...args: unknown[]) => unknown
      ipcMain.handle(channel, async (event, ...args) => {
        guard(event)
        try {
          return await call(...args)
        } catch (error) {
          throw humanized(error)
        }
      })
    },
    rawHandle(channel, fn) {
      const call = fn as (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown
      ipcMain.handle(channel, async (event, ...args) => {
        guard(event)
        try {
          return await call(event, ...args)
        } catch (error) {
          throw humanized(error)
        }
      })
    }
  }
}
