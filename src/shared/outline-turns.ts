import type { UIMessage } from './ipc'
import { createTurnProjector, type AssistantTurn, type UserTurn } from './turns'

export interface OutlineTurn {
  user: string
  assistant: string
  msgId: string
  index: number
  failed: boolean
  timestamp?: number
  elapsedMs?: number
  steps: number
}

/** 每条导航轨独立缓存；已完成的回合不随当前流式文字重建。 */
export function createOutlineProjector(): (messages: UIMessage[], streamingId?: string) => OutlineTurn[] {
  const projectTurns = createTurnProjector()
  const cache = new WeakMap<UserTurn, { reply: AssistantTurn | null; outline: OutlineTurn }>()
  return (messages, streamingId) => {
    const all = projectTurns(messages, streamingId)
    const outlines: OutlineTurn[] = []
    for (let i = 0; i < all.length; i++) {
      const user = all[i]
      if (user.kind !== 'user') continue
      const next = all[i + 1]
      const reply = next?.kind === 'assistant' ? next : null
      const index = outlines.length
      const saved = cache.get(user)
      if (saved && saved.reply === reply && saved.outline.index === index) {
        outlines.push(saved.outline)
        continue
      }
      const outline: OutlineTurn = {
        user: user.msg.text,
        assistant: reply?.response?.text ?? '',
        msgId: user.id,
        index,
        failed: !!reply && (reply.terminalReason === 'failed' || !!reply.error || reply.tools.some((call) => call.status === 'error' && !call.cancelled)),
        timestamp: user.msg.timestamp,
        elapsedMs: reply?.elapsedMs,
        steps: reply?.tools.length ?? 0
      }
      cache.set(user, { reply, outline })
      outlines.push(outline)
    }
    return outlines
  }
}
