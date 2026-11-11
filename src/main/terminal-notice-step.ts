export type TerminalNoticeStep = 'drop' | 'wait' | 'steer' | 'wake' | 'hold'

export interface TerminalNoticeSituation {
  stopping: boolean
  owned: boolean
  ready: boolean
  running: boolean
  wake: boolean
}

export const HELD_TERMINAL_NOTICES_MAX = 10

export function terminalNoticeStep(situation: TerminalNoticeSituation): TerminalNoticeStep {
  if (situation.stopping || !situation.owned) return 'drop'
  if (!situation.ready) return 'wait'
  if (situation.running) return 'steer'
  return situation.wake ? 'wake' : 'hold'
}
