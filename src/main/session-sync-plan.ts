import type { UIMessage } from '../shared/ipc'
import { messageSyncSignature, messagesSyncWeight } from '../shared/session-sync'

export interface SessionSyncLimits {
  maxDeltaChars?: number
  maxRatio?: number
}

export type SessionSyncPlan =
  | { kind: 'none' }
  | { kind: 'full' }
  | { kind: 'delta'; anchorId: string; anchorIndex: number; anchorSignature: string; messages: UIMessage[] }

const DEFAULT_MAX_DELTA_CHARS = 1024 * 1024
const DEFAULT_MAX_RATIO = 0.6
const MIN_RATIO_CHECK_CHARS = 16 * 1024

function commonPrefix(previous: readonly UIMessage[], next: readonly UIMessage[]): number {
  const limit = Math.min(previous.length, next.length)
  let index = 0
  while (index < limit && previous[index].id === next[index].id) index += 1
  return index
}

export function planSessionSync(
  previous: readonly UIMessage[] | undefined,
  next: readonly UIMessage[],
  limits: SessionSyncLimits = {}
): SessionSyncPlan {
  if (!previous) return { kind: 'full' }
  if (!next.length) return { kind: 'full' }
  const common = commonPrefix(previous, next)
  let from = common
  for (let index = 0; index < common; index += 1) {
    if (messageSyncSignature(previous[index]) !== messageSyncSignature(next[index])) {
      from = index
      break
    }
  }
  if (from === 0) return { kind: 'full' }
  if (from === previous.length && from === next.length) return { kind: 'none' }
  const messages = next.slice(from)
  const deltaWeight = messagesSyncWeight(messages)
  const maxDeltaChars = limits.maxDeltaChars ?? DEFAULT_MAX_DELTA_CHARS
  if (deltaWeight > maxDeltaChars) return { kind: 'full' }
  const maxRatio = limits.maxRatio ?? DEFAULT_MAX_RATIO
  if (deltaWeight >= MIN_RATIO_CHECK_CHARS) {
    const totalWeight = messagesSyncWeight(next)
    if (totalWeight > 0 && deltaWeight > totalWeight * maxRatio) return { kind: 'full' }
  }
  const anchor = next[from - 1]
  return {
    kind: 'delta',
    anchorId: anchor.id,
    anchorIndex: from - 1,
    anchorSignature: messageSyncSignature(anchor),
    messages
  }
}
