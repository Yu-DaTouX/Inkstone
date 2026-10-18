import type { TurnTerminalReason } from './ipc'

export type TurnOutcome = 'completed' | 'failed' | 'stopped'

export function settledTurnOutcome(input: {
  aborted: boolean
  terminal: TurnTerminalReason
  modelError: boolean
}): TurnOutcome {
  if (input.terminal === 'stopped') return 'stopped'
  if (input.aborted || input.modelError || input.terminal === 'failed' || input.terminal === 'interrupted') return 'failed'
  return 'completed'
}

export function attentionForOutcome(outcome: TurnOutcome): 'done' | 'error' | null {
  if (outcome === 'completed') return 'done'
  if (outcome === 'failed') return 'error'
  return null
}
