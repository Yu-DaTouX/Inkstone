import type { UIMessage } from './ipc'

function toolCallSignature(call: NonNullable<UIMessage['toolCalls']>[number]): string {
  return [
    call.id,
    call.name,
    call.status,
    call.cancelled ? 'c' : '',
    call.denied ? 'd' : '',
    call.incomplete ? 'i' : '',
    call.historySummary ? 'h' : '',
    call.output?.length ?? 0,
    call.argsRaw?.length ?? 0,
    call.images?.length ?? 0,
    call.parentToolCallId ?? ''
  ].join(':')
}

export function messageSyncSignature(message: UIMessage): string {
  const parts = [
    message.id,
    message.role,
    message.entryId ?? '',
    message.note?.kind ?? '',
    message.text.length,
    message.text.charCodeAt(0) || 0,
    message.text.charCodeAt(message.text.length - 1) || 0,
    message.thinking?.length ?? 0,
    message.images?.length ?? 0,
    message.artifacts?.map((artifact) => `${artifact.id}${artifact.unavailable ? '!' : ''}`).join(',') ?? '',
    message.turnTiming ? `${message.turnTiming.logicalTurnId}:${message.turnTiming.endedAt}` : '',
    message.usage?.totalTokens ?? '',
    message.error ?? '',
    message.bash ? `${message.bash.exitCode ?? ''}:${message.bash.command.length}` : ''
  ]
  for (const call of message.toolCalls ?? []) parts.push(toolCallSignature(call))
  return parts.join('\u0001')
}

export function messageSyncWeight(message: UIMessage): number {
  let weight = message.text.length
  if (message.thinking) weight += message.thinking.length
  for (const call of message.toolCalls ?? []) {
    weight += call.output?.length ?? 0
    weight += call.argsRaw?.length ?? 0
    for (const image of call.images ?? []) weight += image.data.length
  }
  for (const image of message.images ?? []) weight += image.data.length
  return weight
}

export function messagesSyncWeight(messages: readonly UIMessage[]): number {
  let weight = 0
  for (const message of messages) weight += messageSyncWeight(message)
  return weight
}
