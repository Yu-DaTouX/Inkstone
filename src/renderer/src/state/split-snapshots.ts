import type { UIMessage } from '../../../shared/ipc'

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
