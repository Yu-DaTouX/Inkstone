import type { HistoryMessage, HistoryPage } from './api/client'

const sizes = new WeakMap<HistoryMessage, number>()

function sizeOf(message: HistoryMessage): number {
  let size = sizes.get(message)
  if (size === undefined) {
    size = JSON.stringify(message).length * 2
    sizes.set(message, size)
  }
  return size
}

export class HistoryCache {
  private entries = new Map<string, { page: HistoryPage; size: number }>()
  private size = 0
  get(id: string) {
    const entry = this.entries.get(id)
    if (!entry) return undefined
    this.entries.delete(id)
    this.entries.set(id, entry)
    return entry.page
  }
  set(id: string, page: HistoryPage) {
    const messages = [...page.messages]
    let size = 0
    const tail: HistoryMessage[] = []
    for (let i = messages.length - 1; i >= 0 && tail.length < 120; i--) {
      const messageSize = sizeOf(messages[i])
      if (size + messageSize > 1024 * 1024) break
      tail.unshift(messages[i])
      size += messageSize
    }
    const old = this.entries.get(id)
    if (old) { this.size -= old.size; this.entries.delete(id) }
    const clipped = tail.length < messages.length
    this.entries.set(id, { page: { ...page, messages: tail, hasMore: clipped || page.hasMore, nextBefore: clipped ? tail[0]?.id : page.nextBefore }, size })
    this.size += size
    while (this.entries.size > 6 || this.size > 2 * 1024 * 1024) {
      const first = this.entries.keys().next().value!
      this.size -= this.entries.get(first)!.size
      this.entries.delete(first)
    }
  }
}

export function mergeRecentHistory(previous: HistoryMessage[], recent: HistoryMessage[]) {
  const first = recent[0]?.id
  const at = first ? previous.findIndex((message) => message.id === first) : -1
  return { messages: at > 0 ? [...previous.slice(0, at), ...recent] : recent, retained: at > 0 }
}
