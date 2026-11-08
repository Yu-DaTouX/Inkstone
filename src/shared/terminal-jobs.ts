import type { TerminalNoticeState } from './host-notice-text'

export type TerminalJobState = 'running' | 'stopping' | TerminalNoticeState

export interface TerminalJob {
  id: string
  terminalId: string
  owners: string[]
  command: string
  cwd: string
  startedAt: number
  endedAt?: number
  state: TerminalJobState
}

export function isLiveTerminalJob(job: Pick<TerminalJob, 'state'>): boolean {
  return job.state === 'running' || job.state === 'stopping'
}

export function terminalJobOwnedBy(job: Pick<TerminalJob, 'owners'>, key: string): boolean {
  const norm = (value: string): string => value.replace(/\\/g, '/').toLowerCase()
  const target = norm(key)
  return !!target && job.owners.some((owner) => norm(owner) === target)
}
