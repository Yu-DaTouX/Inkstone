/** Record settled run observations without driving another agent turn. */

import type { MainPush, SessionState } from '../shared/ipc'


export interface SessionWorkDeps {
  /** 当前实例状态；实例不存在时返回 null */
  stateOf(id: string): SessionState | null
  /** 交接操作是否仍在进行（含作为交接目标的实例） */
  hasHandoffOperation(id: string): boolean
  consumeRepeatBlocks(id: string): Promise<void>
}

export interface SessionWorkScheduler {
  /** 把一次「回合空下来之后看看要不要做事」排进该会话的串行链 */
  schedule(id: string, reason: string): Promise<void>
  /** 运行推送的观察钩子：回合结束后记录重复动作的处理结果 */
  observePush(id: string, msg: MainPush): void
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
    }
  }
}
