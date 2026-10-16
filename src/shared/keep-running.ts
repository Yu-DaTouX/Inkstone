export const KEEP_RUNNING_DONE_MARK = '【任务已完成】'

export const KEEP_RUNNING_MAX = 50

export const KEEP_RUNNING_PROMPT =
  `继续完成任务。如果有进度记录（账本），先读它，从下一项接着做，不要在中途结束回合。` +
  `如果任务已全部完成，回复的最后一行只写「${KEEP_RUNNING_DONE_MARK}」，不要再做别的。`

export interface KeepRunningTurn {
  error: boolean
  toolCalls: number
  lastText: string
}

export type KeepRunningDecision =
  | { next: 'continue' }
  | { next: 'skip' }
  | { next: 'stop'; reason: 'done' | 'idle' | 'limit' }

export function hasDoneMark(text: string): boolean {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  return !!lines.length && lines[lines.length - 1].includes(KEEP_RUNNING_DONE_MARK)
}

export function decideKeepRunning(turn: KeepRunningTurn, count: number, max = KEEP_RUNNING_MAX): KeepRunningDecision {
  if (hasDoneMark(turn.lastText)) return { next: 'stop', reason: 'done' }
  if (turn.error) return { next: 'skip' }
  if (turn.toolCalls === 0) return { next: 'stop', reason: 'idle' }
  if (count >= max) return { next: 'stop', reason: 'limit' }
  return { next: 'continue' }
}
