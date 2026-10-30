import { formatWorkingDurationLabel } from '../../internal/models'
import { effectiveSnoozed } from '../../internal/thread-settled'
import type { SidebarThreadView } from './types'

export type RowStatus = 'working' | 'waiting' | 'approval' | 'input' | 'failed' | 'done' | null

export function resolveRowStatus(view: SidebarThreadView, now: number): RowStatus {
  if (view.hasPendingApprovals) return 'approval'
  if (view.hasPendingUserInput) return 'input'
  if (effectiveSnoozed(view, now)) return 'waiting'
  if (view.runtime?.status === 'failed') return 'failed'
  if (view.runtime?.status === 'waiting') return 'waiting'
  if (
    view.runtime !== null &&
    (view.runtime.status === 'running' || view.runtime.status === 'queued' || view.runtime.status === 'starting' || view.runtime.status === 'preparing')
  ) {
    return view.blockedOnThreadWait ? 'waiting' : 'working'
  }
  return view.unread ? 'done' : null
}

const TONES: Record<Exclude<RowStatus, null>, string> = {
  working: 'text-info-foreground',
  waiting: 'text-muted-foreground',
  approval: 'text-warning-foreground',
  input: 'text-indigo-600 dark:text-indigo-300',
  failed: 'text-error-foreground',
  done: 'text-success-foreground'
}

export function resolveStatusTone(status: RowStatus): string {
  return status === null ? 'text-muted-foreground' : TONES[status]
}

export function formatWorkingDuration(ms: number): string {
  return formatWorkingDurationLabel(ms)
}

export function rowIsReceded(status: RowStatus, unread: boolean, active: boolean): boolean {
  if (active || status === 'input') return false
  if (status === 'working' || status === 'waiting') return true
  return status === 'approval' ? !unread : false
}
