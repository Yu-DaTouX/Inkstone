interface ForkTarget {
  entryId?: string
  text: string
}

interface MessageLike {
  id: string
  role: string
  text?: string
  entryId?: string
}

export function forkTargetAfter(messages: readonly MessageLike[], sourceIds: readonly string[], skip: (text: string) => boolean = () => false): ForkTarget | null {
  if (!sourceIds.length) return null
  const owned = new Set(sourceIds)
  let last = -1
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (owned.has(messages[i].id)) {
      last = i
      break
    }
  }
  if (last < 0) return null
  for (let i = last + 1; i < messages.length; i += 1) {
    const msg = messages[i]
    if (msg.role !== 'user') continue
    const text = msg.text ?? ''
    if (!text.trim() || skip(text)) continue
    return { ...(msg.entryId ? { entryId: msg.entryId } : {}), text }
  }
  return null
}
