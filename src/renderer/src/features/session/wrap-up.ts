import type { UIMessage, UIToolCall } from '../../../../shared/ipc'
import type { AssistantTurn, TurnSegment, TurnThinking } from '../../../../shared/turns'

const LEGACY_WRAP_UP_TOOL = 'wrap_up'

function isWrapUpCall(call: Pick<UIToolCall, 'name'>): boolean {
  return call.name === LEGACY_WRAP_UP_TOOL
}

const strippedMessages = new WeakMap<UIMessage, UIMessage>()

function stripMessage(message: UIMessage): UIMessage {
  const cached = strippedMessages.get(message)
  if (cached) return cached
  if (!message.toolCalls?.some(isWrapUpCall)) {
    strippedMessages.set(message, message)
    return message
  }
  const toolCalls = message.toolCalls.filter((call) => !isWrapUpCall(call))
  const next: UIMessage = { ...message, toolCalls }
  strippedMessages.set(message, next)
  return next
}

export function withoutWrapUpMessages(messages: UIMessage[]): UIMessage[] {
  let changed = false
  const next = messages.map((message) => {
    const stripped = stripMessage(message)
    if (stripped !== message) changed = true
    return stripped
  })
  return changed ? next : messages
}

function shiftThinking(parts: TurnThinking[], removed: number[]): TurnThinking[] {
  return parts.map((part) => {
    const before = removed.filter((index) => index < part.at).length
    return before ? { ...part, at: part.at - before } : part
  })
}

function stripSegment(segment: TurnSegment): TurnSegment {
  const removed: number[] = []
  segment.tools.forEach((call, index) => {
    if (isWrapUpCall(call)) removed.push(index)
  })
  if (!removed.length) return segment
  return {
    ...segment,
    tools: segment.tools.filter((call) => !isWrapUpCall(call)),
    ...(segment.thinkingParts ? { thinkingParts: shiftThinking(segment.thinkingParts, removed) } : {})
  }
}

export function withoutWrapUp(turn: AssistantTurn): AssistantTurn {
  if (!turn.tools.some(isWrapUpCall)) return turn
  return {
    ...turn,
    tools: turn.tools.filter((call) => !isWrapUpCall(call)),
    segments: turn.segments.map(stripSegment)
  }
}
