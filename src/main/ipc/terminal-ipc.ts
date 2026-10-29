import type { TerminalStartRequest } from '../../shared/ipc'
import {
  attachTerminal,
  clearTerminal,
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
      rows: request?.rows,
      owner: request?.owner,
      title: request?.title
    })
  )
  rawHandle('yan:terminal:write', (_e, id: string, data: string) => writeTerminal(String(id ?? ''), String(data ?? '')))
  rawHandle('yan:terminal:resize', (_e, id: string, cols: number, rows: number) =>
    resizeTerminal(String(id ?? ''), Number(cols), Number(rows))
  )
  rawHandle('yan:terminal:kill', (_e, id: string) => killTerminal(String(id ?? '')))
  rawHandle('yan:terminal:attach', (_e, id: string) => attachTerminal(String(id ?? '')))
  rawHandle('yan:terminal:clear', (_e, id: string) => clearTerminal(String(id ?? '')))
}
