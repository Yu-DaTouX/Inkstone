export interface MessageIndex {
  pos: Map<string, number>
  firstAssistantId: string | null
  lastMessageId: string | null
}

type Indexable = { id: string; role: string }

const layouts = new WeakMap<readonly Indexable[], { index?: MessageIndex }>()

function messageLayout(messages: readonly Indexable[]): { index?: MessageIndex } {
  let layout = layouts.get(messages)
  if (!layout) {
    layout = {}
    layouts.set(messages, layout)
  }
  return layout
}

export function replaceIndexedMessage<T extends Indexable>(messages: readonly T[], position: number, message: T): T[] {
  const next = messages.slice()
  const before = messages[position]
  next[position] = message
  if (before?.id === message.id && before.role === message.role) layouts.set(next, messageLayout(messages))
  return next
}

export function messageIndex(messages: readonly Indexable[]): MessageIndex {
  const layout = messageLayout(messages)
  const cached = layout.index
  if (cached) return cached
  const pos = new Map<string, number>()
  let firstAssistantId: string | null = null
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]
    if (!pos.has(message.id)) pos.set(message.id, i)
    if (firstAssistantId === null && message.role === 'assistant') firstAssistantId = message.id
  }
  const index = { pos, firstAssistantId, lastMessageId: messages[messages.length - 1]?.id ?? null }
  layout.index = index
  return index
}
