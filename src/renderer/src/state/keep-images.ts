import type { UIMessage } from '../../../shared/ipc'

export function keepLocalImages(prev: UIMessage[], next: UIMessage[]): UIMessage[] {
  if (!prev.length || !next.length) return next

  const before = new Map<string, UIMessage>()
  for (const msg of prev) if (msg.images?.length) before.set(msg.id, msg)
  if (!before.size) return next

  let changed = false
  const out = next.map((msg) => {
    if (msg.images?.some((im) => im.data || im.url)) return msg
    const local = before.get(msg.id)
    if (!local?.images?.length) return msg
    if (local.role !== msg.role || (local.text ?? '') !== (msg.text ?? '')) return msg
    changed = true
    return { ...msg, images: local.images }
  })

  return changed ? out : next
}
