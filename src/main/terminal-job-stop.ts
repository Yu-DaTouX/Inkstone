import { stopBackgroundBash } from './background-bash'
import { writeTerminal } from './terminal'
import { requestTerminalJobStop, terminalJob } from './terminal-jobs'

export function stopTerminalJob(jobId: string): boolean {
  const bash = terminalJob(jobId)?.kind === 'bash'
  const terminalId = requestTerminalJobStop(jobId)
  if (terminalId === null) return false
  return bash ? stopBackgroundBash(jobId) : writeTerminal(terminalId, '\x03')
}
