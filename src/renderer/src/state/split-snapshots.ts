import type { UIMessage } from '../../../shared/ipc'

const shown = new Map<string, UIMessage[]>()
const LIMIT = 16
const MAX_SHOWN_BYTES = 32 * 1024 * 1024
const messageBytes = (items: UIMessage[]): number => {
  let total = 0
  for (const item of items) total += (JSON.stringify(item).length * 2)
  return total
}

const normPath = (p: string): string => p.replace(/[\\/]+/g, '/').toLowerCase()
const keysOf = (ref: { sessionId?: string | null; path?: string | null }): string[] =>
  [ref.sessionId ? `id:${ref.sessionId}` : '', ref.path ? `path:${normPath(ref.path)}` : ''].filter(Boolean)

export function rememberShown(ref: { sessionId?: string | null; path?: string | null }, messages: UIMessage[]): void {
  if (!messages.length || messageBytes(messages) > MAX_SHOWN_BYTES) return
  for (const key of keysOf(ref)) {
    shown.delete(key)
    shown.set(key, messages)
  }
  let bytes = [...shown.values()].reduce((sum, items) => sum + messageBytes(items), 0)
  while (shown.size > LIMIT * 2 || bytes > MAX_SHOWN_BYTES) {
    const oldest = shown.keys().next().value as string | undefined
    if (!oldest) break
    bytes -= messageBytes(shown.get(oldest) ?? [])
    shown.delete(oldest)
  }
}

export function latestTimestamp(messages: UIMessage[] | undefined): number {
  if (!messages) return 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const ts = messages[i].timestamp
    if (typeof ts === 'number' && ts > 0) return ts
  }
  return 0
}

export function newestMessages(...candidates: (UIMessage[] | undefined)[]): UIMessage[] | undefined {
  let best: UIMessage[] | undefined
  let bestTs = -1
  for (const list of candidates) {
    if (!list?.length) continue
    const ts = latestTimestamp(list)
    if (ts > bestTs) { best = list; bestTs = ts }
  }
  return best
}

export function shownMessages(ref: { sessionId?: string | null; path?: string | null }): UIMessage[] | undefined {
  for (const key of keysOf(ref)) {
    const hit = shown.get(key)
    if (hit?.length) return hit
  }
  return undefined
}
