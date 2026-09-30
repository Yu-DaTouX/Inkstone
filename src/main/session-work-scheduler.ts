/** Record settled run observations without driving another agent turn. */

import type { MainPush, SessionState } from '../shared/ipc'


import type { AutoContinueStore } from './auto-continue-service'

export interface SessionWorkDeps {
  /** 当前实例状态；实例不存在时返回 null */
  stateOf(id: string): SessionState | null
  /** 交接操作是否仍在进行（含作为交接目标的实例） */
  hasHandoffOperation(id: string): boolean
  /** 交接现场是否仍挂着（重复拦下可能在中途清掉它） */
  handoffPending(id: string): boolean
  consumeRepeatBlocks(id: string): Promise<void>
  /** 满足资格时发起交接；发起了返回 true */
  tryArmHandoff(id: string, reason: string): Promise<boolean>
  maybeArmGoalContinue(id: string): Promise<void>
  /** 会话的工作模式键（自动继续计数按它落盘）；没有时不做自动继续 */
  workModeKeyFor(id: string): string | null
  autoContinues: AutoContinueStore
  /** 自动继续的有效上限（测试通道可覆盖） */
  autoContinueLimit: number
  /** 写「待发续行」快照；薄层在回合空闲时据此发一条 custom 消息 */
  writeRetrySnapshot(id: string, snapshot: { operationId: string; at: number; kind: 'retry'; summary: string }): Promise<void>
  notify(id: string, message: string, notifyType: 'info' | 'warning' | 'error', idPrefix: string): void
}

export interface SessionWorkScheduler {
  /** 把一次「回合空下来之后看看要不要做事」排进该会话的串行链 */
  schedule(id: string, reason: string): Promise<void>
  /** 运行推送的观察钩子：回合结束后记录重复动作的处理结果 */
  observePush(id: string, msg: MainPush): void
  /** 用户发言 / 停止 / 一轮成功 → 失败计数归零（并撤掉待发的自动继续） */
  resetAutoContinue(id: string): Promise<void>
  cancelAutoContinue(id: string): void
  /** 是否有待发的自动继续（调度判定用） */
  hasPendingAutoContinue(id: string): boolean
}

/** Observe settled runs without creating synthetic prompts, summaries, or retries. */
export function createSessionWorkScheduler(deps: SessionWorkDeps): SessionWorkScheduler {
  const running = new Map<string, boolean>()
  const tails = new Map<string, Promise<void>>()
  function schedule(id: string, _reason: string): Promise<void> {
    const previous = tails.get(id) ?? Promise.resolve()
    const next = previous.then(async () => {
      const state = deps.stateOf(id)
      if (!state || state.isAgentRunning || state.isStreaming || state.isCompacting || deps.hasHandoffOperation(id)) return
      await deps.consumeRepeatBlocks(id)
    }).catch(() => undefined)
    tails.set(id, next)
    void next.then(() => { if (tails.get(id) === next) tails.delete(id) })
    return next
  }
  return {
    schedule,
    observePush(id, msg) {
      if (msg.ch !== 'state') return
      const now = msg.payload.isAgentRunning === true
      const was = running.get(id) === true
      running.set(id, now)
      if (was && !now) void schedule(id, 'settled')
    },
    async resetAutoContinue(_id) {},
    cancelAutoContinue(_id) {},
    hasPendingAutoContinue: () => false
  }
}
