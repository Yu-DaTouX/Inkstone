export interface MessageIndex {
  pos: Map<string, number>
  firstAssistantId: string | null
  lastMessageId: string | null
}

type Indexable = { id: string; role: string }

const indexes = new WeakMap<readonly Indexable[], MessageIndex>()

export function messageIndex(messages: readonly Indexable[]): MessageIndex {
  const cached = indexes.get(messages)
  if (cached) return cached
  const pos = new Map<string, number>()
  let firstAssistantId: string | null = null
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]
    if (!pos.has(message.id)) pos.set(message.id, i)
    if (firstAssistantId === null && message.role === 'assistant') firstAssistantId = message.id
  }
  const index = { pos, firstAssistantId, lastMessageId: messages[messages.length - 1]?.id ?? null }
  indexes.set(messages, index)
  return index
}
