import type { RunPhase, RunSnapshot } from '../../../../shared/runs'

export type SideMoreId = 'schedule' | 'collab' | 'artifacts'
export type SideMoreAttention = 'awaiting' | 'running'

export interface SideMoreEntry {
  id: SideMoreId
  attention: SideMoreAttention | null
}

export interface SideMoreSignals {
  available: ReadonlySet<SideMoreId>
  schedulePendingApproval: boolean
  pairInvitePending: boolean
  runs: readonly Pick<RunSnapshot, 'kind' | 'phase'>[]
}

export const SIDE_MORE_ORDER: readonly SideMoreId[] = ['schedule', 'collab', 'artifacts']

const ACTIVE_PHASES: ReadonlySet<RunPhase['kind']> = new Set(['queued', 'running', 'needs-you', 'stalled'])

export function isActiveRunPhase(phase: RunPhase): boolean {
  return ACTIVE_PHASES.has(phase.kind)
}

export function activeRunCount(runs: readonly Pick<RunSnapshot, 'phase'>[]): number {
  return runs.reduce((count, run) => (isActiveRunPhase(run.phase) ? count + 1 : count), 0)
}

function attentionOf(id: SideMoreId, signals: SideMoreSignals): SideMoreAttention | null {
  if (id === 'schedule') {
    if (signals.schedulePendingApproval) return 'awaiting'
    return signals.runs.some((run) => run.kind === 'scheduled' && isActiveRunPhase(run.phase)) ? 'running' : null
  }
  if (id === 'collab') return signals.pairInvitePending ? 'awaiting' : null
  return null
}

export function sideMoreEntries(signals: SideMoreSignals): SideMoreEntry[] {
  return SIDE_MORE_ORDER.filter((id) => signals.available.has(id)).map((id) => ({ id, attention: attentionOf(id, signals) }))
}

export interface SideMoreLayout {
  shown: SideMoreEntry[]
  folded: SideMoreEntry[]
  foldedCurrent: boolean
}

export function sideMoreLayout(entries: readonly SideMoreEntry[], route: string): SideMoreLayout {
  const folded = entries.filter((entry) => entry.attention === null)
  if (folded.length < 2) return { shown: [...entries], folded: [], foldedCurrent: false }
  const shown = entries.filter((entry) => entry.attention !== null)
  return { shown, folded, foldedCurrent: folded.some((entry) => entry.id === route) }
}
