/**
 * IPC 注册器：所有 `yan:*` 处理器共用的来源校验。
 *
 * 渲染端只能经 preload 白名单调用宿主能力；主进程这边再核对一次调用来自主窗口，
 * 其它 webContents（内置浏览器里的网页、DevTools 等）发来的同名调用一律拒绝。
 *
 * 按领域拆开的适配文件（ipc/*-ipc.ts）拿到的是这个注册器，而不是 ipcMain ——
 * 新增入口时不可能绕过校验。
 */
import { ipcMain } from 'electron'

export interface IpcRegistrar {
  /** 只要参数的处理器 */
  handle<T>(channel: string, fn: (...args: never[]) => Promise<T> | T): void
  /** 需要事件对象（例如读 sender）的处理器 */
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
