import type { TerminalProgramStatus } from '../../../../shared/ipc'

export interface TerminalRunningEntry {
  id: string
  owner?: string
  alive: boolean
  status?: TerminalProgramStatus
}

export function isTerminalCommandRunning(entry: TerminalRunningEntry): boolean {
  return entry.alive && (entry.status?.state === 'working' || entry.status?.state === 'blocked')
}

export function ownerTerminalRunning(
  entries: Iterable<TerminalRunningEntry>,
  ownerKey: string,
  ownerOf: (resourceId: string) => string | undefined
): boolean {
  for (const entry of entries) {
    if ((entry.owner ?? ownerOf('terminal:' + entry.id)) !== ownerKey) continue
    if (isTerminalCommandRunning(entry)) return true
  }
  return false
}
