/**
 * 子代理此刻处在什么状态：界面卡片与结束通知共用的**唯一**说法。
 *
 * 原先界面只有「运行中 / 失败 / 已完成」三个词，超时、模型报错、调用用完、被停止、
 * 有部分结果都压成「失败」或「已完成」，读的人分不清哪条要处理。这里把
 * `status / endReason / review / wrapUp` 折成一个 `key`，再给出语气与是否需要人看。
 *
 * 纯函数，不碰 electron，主进程与渲染端、单测共用。
 */
import type { SubagentRun } from './ipc'

export type SubagentOutcomeKey =
  | 'starting'
  | 'running'
  | 'wrapUp'
  | 'done'
  | 'timeout'
  | 'budget'
  | 'failed'
  | 'stopped'
  | 'review'
  | 'conflict'

/** 语气决定颜色：live 强调色、ok 绿、warn 琥珀、err 红、mute 灰 */
export type SubagentTone = 'live' | 'ok' | 'warn' | 'err' | 'mute'

export interface SubagentOutcome {
  key: SubagentOutcomeKey
  tone: SubagentTone
  /** 还在跑（含启动与收尾） */
  live: boolean
  /** 需要人处理：出错、超时或调用用完后结论可能不完整、待合并、有冲突 */
  attention: boolean
  /** 结论可能不完整（超时 / 调用用完后收尾或被停） */
  partial: boolean
  /** 排序：0 运行中 → 1 需要处理 → 2 其余 */
  rank: 0 | 1 | 2
}

type OutcomeInput = Pick<SubagentRun, 'status' | 'review'> & Partial<Pick<SubagentRun, 'endReason' | 'wrapUp'>>

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
    if (run.endReason === 'timeout') return make('timeout', 'warn', true)
    if (run.endReason === 'budget') return make('budget', 'warn', true)
    return make('failed', 'err', true)
  }
  /* done：先看有没有等人处理的改动，再看是不是收尾出来的部分结论 */
  if (run.review === 'conflict') return make('conflict', 'err', true)
  if (run.review === 'pending') return make('review', 'warn', true)
  if (run.endReason === 'timeout') return make('timeout', 'warn', true)
  if (run.endReason === 'budget') return make('budget', 'warn', true)
  return make('done', 'ok', false)
}
