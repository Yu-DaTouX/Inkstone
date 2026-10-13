/**
 * 「持续运行」的纯判定：用户为一条会话手动打开后，回合正常结束就自动发一句继续，
 * 直到模型写出完成标记、空转或达到上限。不碰会话与定时器；宿主侧（store）只负责取回合摘要和发送。
 */

/** 模型确认全部完成时，回复最后一行写这个标记。 */
export const KEEP_RUNNING_DONE_MARK = '【任务已完成】'

/** 连续自动继续的上限：防止模型一直不收尾时无止境消耗额度。 */
export const KEEP_RUNNING_MAX = 50

/** 自动发出的继续消息：先对照进度记录，做完了就只回完成标记，这样忘写标记时下一轮也能收住。 */
export const KEEP_RUNNING_PROMPT =
  `继续完成任务。如果有进度记录（账本），先读它，从下一项接着做，不要在中途结束回合。` +
  `如果任务已全部完成，回复的最后一行只写「${KEEP_RUNNING_DONE_MARK}」，不要再做别的。`

/** 刚结束的这一回合的摘要。 */
export interface KeepRunningTurn {
  /** 回合以错误结束（含额度用尽、非用户中止） */
  error: boolean
  /** 本回合的工具调用数 */
  toolCalls: number
  /** 本回合最后一段有正文的回复 */
  lastText: string
}

export type KeepRunningDecision =
  | { next: 'continue' }
  /** 错误结束：不发继续，保持开启，交给换号 / 等待恢复 */
  | { next: 'skip' }
  | { next: 'stop'; reason: 'done' | 'idle' | 'limit' }

/** 最后一个非空行含完成标记才算完成；正文中间提到标记（如复述要求）不算。 */
export function hasDoneMark(text: string): boolean {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  return !!lines.length && lines[lines.length - 1].includes(KEEP_RUNNING_DONE_MARK)
}

/** count：本次开启后已经自动继续的次数。 */
export function decideKeepRunning(turn: KeepRunningTurn, count: number, max = KEEP_RUNNING_MAX): KeepRunningDecision {
  if (hasDoneMark(turn.lastText)) return { next: 'stop', reason: 'done' }
  if (turn.error) return { next: 'skip' }
  if (turn.toolCalls === 0) return { next: 'stop', reason: 'idle' }
  if (count >= max) return { next: 'stop', reason: 'limit' }
  return { next: 'continue' }
}
