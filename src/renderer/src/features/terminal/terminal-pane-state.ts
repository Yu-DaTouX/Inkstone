import { isLiveTerminalJob, type TerminalJob } from '../../../../shared/terminal-jobs'
import type { Store } from '../../state/store'

export function terminalAwaitingConfirm(approvals: Store['approvals'], sessionId: string | null): boolean {
  return approvals.some((request) => request.tool === 'terminal' && !request.subagentId && request.phase !== 'resolved' && (!request.sessionId || !sessionId || request.sessionId === sessionId))
}

export function isLiveAgentJob(job: TerminalJob): boolean {
  return job.kind !== 'bash' && isLiveTerminalJob(job)
}

interface TerminalPaneJobs {
  count: number
  commands: ReadonlyMap<string, string>
}

export function createTerminalPaneJobsSelector() {
  let previousJobs: readonly TerminalJob[] | undefined
  let previousIds: readonly string[] = []
  let previous: TerminalPaneJobs = { count: 0, commands: new Map() }
  return (jobs: readonly TerminalJob[], ids: readonly string[]): TerminalPaneJobs => {
    if (jobs === previousJobs && ids.length === previousIds.length && ids.every((id, index) => id === previousIds[index])) return previous
    previousJobs = jobs
    previousIds = ids
    const commands = new Map<string, string>()
    let count = 0
    if (ids.length) {
      const paneIds = new Set(ids)
      for (const job of jobs) {
        if (!paneIds.has(job.terminalId) || !isLiveAgentJob(job)) continue
        count++
        if (!commands.has(job.terminalId)) commands.set(job.terminalId, job.command)
      }
    }
    if (count !== previous.count || commands.size !== previous.commands.size || [...commands].some(([id, command]) => previous.commands.get(id) !== command)) {
      previous = { count, commands }
    }
    return previous
  }
}
