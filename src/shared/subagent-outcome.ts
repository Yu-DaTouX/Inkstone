import type { SubagentRun } from './ipc'

export type SubagentOutcomeKey =
  | 'starting'
  | 'running'
  | 'wrapUp'
  | 'done'
  | 'timeout'
  | 'budget'
  | 'failed'
  | 'dismissed'
  | 'stopped'
  | 'review'
  | 'conflict'

export type SubagentTone = 'live' | 'ok' | 'warn' | 'err' | 'mute'

export interface SubagentOutcome {
  key: SubagentOutcomeKey
  tone: SubagentTone
  live: boolean
  attention: boolean
  partial: boolean
  rank: 0 | 1 | 2
}

type OutcomeInput = Pick<SubagentRun, 'status' | 'review'> &
  Partial<Pick<SubagentRun, 'endReason' | 'wrapUp' | 'dismissedAt'>>

export function isDismissed(run: Pick<SubagentRun, 'status'> & Partial<Pick<SubagentRun, 'dismissedAt'>>): boolean {
  return run.status === 'error' && typeof run.dismissedAt === 'number' && Number.isFinite(run.dismissedAt)
}

export function subagentOutcome(run: OutcomeInput): SubagentOutcome {
  const partial = run.endReason === 'timeout' || run.endReason === 'budget'
  const make = (key: SubagentOutcomeKey, tone: SubagentTone, attention: boolean, live = false): SubagentOutcome => ({
    key,
    tone,
    live,
    attention,
    partial,
    rank: live ? 0 : attention ? 1 : 2
  })

  if (run.status === 'starting') return make('starting', 'live', false, true)
  if (run.status === 'running') return make(run.wrapUp ? 'wrapUp' : 'running', run.wrapUp ? 'warn' : 'live', false, true)
  if (run.status === 'cancelled') return make('stopped', 'mute', false)
  if (run.status === 'error') {
    if (isDismissed(run)) return make('dismissed', 'mute', false)
    if (run.endReason === 'timeout') return make('timeout', 'warn', true)
    if (run.endReason === 'budget') return make('budget', 'warn', true)
    return make('failed', 'err', true)
  }
  if (run.review === 'conflict') return make('conflict', 'warn', false)
  if (run.review === 'pending') return make('review', 'mute', false)
  if (run.endReason === 'timeout') return make('timeout', 'warn', true)
  if (run.endReason === 'budget') return make('budget', 'warn', true)
  return make('done', 'ok', false)
}
