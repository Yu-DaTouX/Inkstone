import type { UIMessage, UIToolCall } from '../../../../shared/ipc'
import type { AssistantTurn, Turn, TurnSegment, TurnThinking } from '../../../../shared/turns'

export const WRAP_UP_TOOL = 'wrap_up'
const MAX_ACTIONS = 2

export interface WrapUpAction {
  label: string
  message: string
}

export interface WrapUpCardModel {
  callId: string
  recap: string
  ask: string | null
  actions: WrapUpAction[]
}

export function isWrapUpCall(call: Pick<UIToolCall, 'name'>): boolean {
  return call.name === WRAP_UP_TOOL
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function wrapUpCardOf(call: UIToolCall): WrapUpCardModel | null {
  if (!isWrapUpCall(call) || call.status === 'error' || call.cancelled || call.denied) return null
  const args = record(call.args)
  const recap = text(args?.recap)
  if (!recap) return null
  const ask = text(args?.ask) || null
  const actions = ask && Array.isArray(args?.actions)
    ? args.actions
      .map((item) => ({ label: text(record(item)?.label), message: text(record(item)?.message) }))
      .filter((item) => item.label && item.message)
      .slice(0, MAX_ACTIONS)
    : []
  return { callId: call.id, recap, ask, actions }
}

export function latestWrapUp(calls: readonly UIToolCall[]): WrapUpCardModel | null {
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    if (!isWrapUpCall(calls[i])) continue
    const card = wrapUpCardOf(calls[i])
    if (card) return card
  }
  return null
}

export function wrapUpForTurn(messages: readonly UIMessage[], sourceIds: readonly string[]): WrapUpCardModel | null {
  const ids = new Set(sourceIds)
  const calls: UIToolCall[] = []
  for (const message of messages) {
    if (ids.has(message.id) && message.toolCalls?.length) calls.push(...message.toolCalls)
  }
  return latestWrapUp(calls)
}

export function latestAssistantTurn(turns: readonly Turn[]): AssistantTurn | null {
  const last = turns[turns.length - 1]
  return last?.kind === 'assistant' ? last : null
}

export function sessionWrapUp(input: {
  enabled: boolean
  active: boolean
  busy: boolean
  turns: readonly Turn[]
  messages: readonly UIMessage[]
}): { turnId: string; card: WrapUpCardModel } | null {
  if (!input.enabled || !input.active || input.busy) return null
  const turn = latestAssistantTurn(input.turns)
  if (!turn || turn.streaming) return null
  const card = wrapUpForTurn(input.messages, turn.sourceIds)
  return card ? { turnId: turn.id, card } : null
}

const strippedMessages = new WeakMap<UIMessage, UIMessage>()

function stripMessage(message: UIMessage): UIMessage {
  if (!message.toolCalls?.some(isWrapUpCall)) return message
  const cached = strippedMessages.get(message)
  if (cached) return cached
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
