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

export function registerTerminalIpc(ipc: IpcRegistrar, fallbackCwd: () => string | undefined, managed: (id: string) => boolean = () => false): void {
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
  rawHandle('yan:terminal:write', (_e, id: string, data: string) => !managed(id) && writeTerminal(String(id ?? ''), String(data ?? '')))
  rawHandle('yan:terminal:resize', (_e, id: string, cols: number, rows: number) =>
    !managed(id) && resizeTerminal(String(id ?? ''), Number(cols), Number(rows))
  )
  rawHandle('yan:terminal:kill', (_e, id: string) => killTerminal(String(id ?? '')))
  rawHandle('yan:terminal:attach', (_e, id: string) => attachTerminal(String(id ?? '')))
}
