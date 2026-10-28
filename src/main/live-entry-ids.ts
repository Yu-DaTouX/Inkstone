import type { UIMessage } from '../shared/ipc'
import type { LiteEntry } from './session-entries-lite'

function messageEntryOf(entry: LiteEntry): { id: string; role: string } | null {
  if (entry.type !== 'message' || typeof entry.id !== 'string') return null
  const role = (entry.message as { role?: unknown } | undefined)?.role
  if (typeof role !== 'string') return null
  return { id: entry.id, role: role === 'bashExecution' ? 'bash' : role }
}

export function withTrailingEntryIds(messages: readonly UIMessage[], entries: readonly LiteEntry[]): UIMessage[] | null {
  const taken = new Set<string>()
  for (const message of messages) if (message.entryId) taken.add(message.entryId)
  const assigned = new Map<number, string>()
  let at = messages.length - 1
  for (let index = entries.length - 1; index >= 0 && at >= 0 && !messages[at].entryId; index--) {
    const entry = messageEntryOf(entries[index])
    if (!entry) continue
    if (taken.has(entry.id)) break
    if (entry.role === messages[at].role) {
      assigned.set(at, entry.id)
      at--
    } else if (entry.role !== 'toolResult') break
  }
  if (!assigned.size) return null
  return messages.map((message, index) => {
    const entryId = assigned.get(index)
    return entryId ? { ...message, entryId } : message
  })
}
