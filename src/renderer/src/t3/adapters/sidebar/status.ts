import { effectiveSnoozed } from '../../internal/thread-settled'
import type { SidebarThreadView } from './types'

export type RowStatus = 'working' | 'waiting' | 'approval' | 'input' | 'failed' | 'done' | null

export function resolveRowStatus(view: SidebarThreadView, now: number): RowStatus {
  if (view.hasPendingApprovals) return 'approval'
  if (view.hasPendingUserInput) return 'input'
  if (effectiveSnoozed(view, now)) return null
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

export function rowIsReceded(status: RowStatus, unread: boolean, active: boolean): boolean {
  if (active || status === 'input') return false
  if (status === 'waiting') return true
  return status === 'approval' ? !unread : false
}
