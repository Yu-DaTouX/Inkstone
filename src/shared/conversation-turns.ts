import type { TurnTerminalReason, UIMessage } from './ipc'
import { isSubagentNotice } from './subagent-notice'

export interface ConversationTurn {
  id: string
  logicalTurnId?: string
  question: UIMessage
  messages: UIMessage[]
  answer?: UIMessage
  toolCalls: number
  terminalReason?: TurnTerminalReason
  incomplete: boolean
  startedAt?: number
  endedAt?: number
}

interface Acc {
  question: UIMessage
  messages: UIMessage[]
  logicalTurnId?: string
}

export function buildConversationTurns(messages: UIMessage[]): ConversationTurn[] {
  const accs: Acc[] = []
  let current: Acc | null = null

  for (const m of messages) {
    if (m.role === 'user' && isSubagentNotice(m.text)) continue
    const lid = m.turnTiming?.logicalTurnId

    if (m.role === 'user') {
      const sameTurn =
        !!current && !!lid && !!current.logicalTurnId && lid === current.logicalTurnId
      if (!current || !sameTurn) {
        current = { question: m, messages: [m], ...(lid ? { logicalTurnId: lid } : {}) }
        accs.push(current)
        continue
      }
    }

    if (!current) continue

    current.messages.push(m)
    if (lid && !current.logicalTurnId) current.logicalTurnId = lid
  }

  return accs.map((a) => {
    const msgs = a.messages
    const answer = [...msgs].reverse().find((m) => m.role === 'assistant' && m.text.trim())
    const timings = msgs.filter((m) => m.turnTiming)
    const lastTiming = timings[timings.length - 1]?.turnTiming
    const terminalReason = lastTiming?.terminalReason
    const startedAt = lastTiming?.startedAt ?? msgs[0]?.timestamp
    const endedAt = lastTiming?.endedAt ?? msgs[msgs.length - 1]?.timestamp
    const incomplete =
      !answer ||
      terminalReason === 'stopped' ||
      terminalReason === 'interrupted' ||
      terminalReason === 'failed'

    return {
      id: a.logicalTurnId ?? `turn:${a.question.id}`,
      ...(a.logicalTurnId ? { logicalTurnId: a.logicalTurnId } : {}),
      question: a.question,
      messages: msgs,
      ...(answer ? { answer } : {}),
      toolCalls: msgs.reduce((n, m) => n + (m.toolCalls?.length ?? 0), 0),
      ...(terminalReason ? { terminalReason } : {}),
      incomplete,
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(endedAt !== undefined ? { endedAt } : {})
    }
  })
}
