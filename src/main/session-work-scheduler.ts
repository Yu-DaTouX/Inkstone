import type { MainPush, SessionState } from '../shared/ipc'


export interface SessionWorkDeps {
  stateOf(id: string): SessionState | null
  hasHandoffOperation(id: string): boolean
  consumeRepeatBlocks(id: string): Promise<void>
}

export interface SessionWorkScheduler {
  schedule(id: string, reason: string): Promise<void>
  observePush(id: string, msg: MainPush): void
}

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
