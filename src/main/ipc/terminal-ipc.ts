/**
 * 交互终端的 IPC 适配（`yan:terminal:*`）。
 *
 * 终端由宿主的 node-pty 持有；这里只做参数归一，不决定终端开在哪个目录以外的事情。
 * 调用方没给 cwd 时，用 `fallbackCwd()`（当前活动会话的工作目录）—— 终端默认开在项目里。
 */
import type { TerminalStartRequest } from '../../shared/ipc'
import {
  attachTerminal,
  killTerminal,
  listTerminals,
  resizeTerminal,
  startTerminal,
  terminalAvailable,
  terminalLoadError,
  writeTerminal
} from '../terminal'
import type { IpcRegistrar } from './registrar'

export function registerTerminalIpc(ipc: IpcRegistrar, fallbackCwd: () => string | undefined): void {
  const { rawHandle } = ipc
  rawHandle('yan:terminal:available', () => ({ available: terminalAvailable(), error: terminalLoadError() ?? undefined }))
  rawHandle('yan:terminal:list', () => listTerminals())
  rawHandle('yan:terminal:start', (_e, request?: TerminalStartRequest) =>
    startTerminal({
      cwd: request?.cwd,
      fallbackCwd: fallbackCwd(),
      cols: request?.cols,
      rows: request?.rows
    })
  )
  rawHandle('yan:terminal:write', (_e, id: string, data: string) => writeTerminal(String(id ?? ''), String(data ?? '')))
  rawHandle('yan:terminal:resize', (_e, id: string, cols: number, rows: number) =>
    resizeTerminal(String(id ?? ''), Number(cols), Number(rows))
  )
  rawHandle('yan:terminal:kill', (_e, id: string) => killTerminal(String(id ?? '')))
  rawHandle('yan:terminal:attach', (_e, id: string) => attachTerminal(String(id ?? '')))
}
