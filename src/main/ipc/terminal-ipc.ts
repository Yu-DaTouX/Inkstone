import type { TerminalStartRequest } from '../../shared/ipc'
import {
  attachTerminal,
  clearTerminal,
  killTerminal,
  listTerminals,
  readTerminal,
  resizeTerminal,
  startTerminal,
  terminalAvailable,
  terminalLoadError,
  terminalProcessId,
  writeTerminal
} from '../terminal'
import { noteTerminalUserInput } from '../terminal-agent'
import { listProcessTree } from '../terminal-processes'
import { clearFinishedTerminalJobs, listTerminalJobs, markTerminalJobsStopping, requestTerminalJobStop } from '../terminal-jobs'
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
  rawHandle('yan:terminal:write', (_e, id: string, data: string) => {
    const terminalId = String(id ?? '')
    const text = String(data ?? '')
    const cwd = readTerminal(terminalId)?.cwd
    if (text.includes('\x03')) markTerminalJobsStopping(terminalId)
    const written = writeTerminal(terminalId, text)
    if (written) void noteTerminalUserInput(terminalId, text, cwd ?? '').catch(() => undefined)
    return written
  })
  rawHandle('yan:terminal:resize', (_e, id: string, cols: number, rows: number) =>
    resizeTerminal(String(id ?? ''), Number(cols), Number(rows))
  )
  rawHandle('yan:terminal:kill', (_e, id: string) => {
    markTerminalJobsStopping(String(id ?? ''))
    return killTerminal(String(id ?? ''))
  })
  rawHandle('yan:terminal:attach', (_e, id: string) => attachTerminal(String(id ?? '')))
  rawHandle('yan:terminal:clear', (_e, id: string) => clearTerminal(String(id ?? '')))
  rawHandle('yan:terminal:processes', (_e, id: string) => listProcessTree(terminalProcessId(String(id ?? ''))))
  rawHandle('yan:terminal:jobs', () => listTerminalJobs())
  rawHandle('yan:terminal:jobStop', (_e, id: string) => {
    const terminalId = requestTerminalJobStop(String(id ?? ''))
    return terminalId ? writeTerminal(terminalId, '\x03') : false
  })
  rawHandle('yan:terminal:jobsClear', (_e, ids?: string[]) => {
    clearFinishedTerminalJobs(Array.isArray(ids) ? ids.map(String) : undefined)
    return true
  })
}
