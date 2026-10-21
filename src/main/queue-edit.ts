import type { QueueItem, QueueState } from '../shared/ipc'
import { isSubagentNotice } from '../shared/subagent-notice'

export interface QueueRewriteResult {
  ok: boolean
  error?: string
  dropped?: QueueItem[]
}

export interface ClearedQueue {
  success: boolean
  error?: string
  steering: string[]
  followUp: string[]
}

export interface QueueRewritePort {
  clearQueue(): Promise<ClearedQueue>
  adoptCleared(steering: string[], followUp: string[]): void
  publish(next: QueueState): void
  refill(steering: QueueItem[], followUp: QueueItem[]): Promise<void>
}

export function cloneQueue(state: QueueState): QueueState {
  const clone = (items: QueueItem[]): QueueItem[] =>
    items.map((item) => ({
      id: item.id,
      text: item.text,
      ...(item.images?.length ? { images: item.images.map((image) => ({ ...image })) } : {})
    }))
  return { steering: clone(state.steering), followUp: clone(state.followUp) }
}

function allItems(state: QueueState): QueueItem[] {
  return [...state.steering, ...state.followUp]
}

function itemIds(state: QueueState): Set<string> {
  return new Set(allItems(state).map((item) => item.id))
}

function sameQueue(a: QueueState, b: QueueState): boolean {
  const equal = (left: QueueItem[], right: QueueItem[]): boolean =>
    left.length === right.length &&
    left.every((item, index) => {
      const other = right[index]
      return item.id === other.id && item.text === other.text && sameImages(item.images, other.images)
    })
  return equal(a.steering, b.steering) && equal(a.followUp, b.followUp)
}

function sameImages(left: QueueItem['images'], right: QueueItem['images']): boolean {
  const a = left ?? []
  const b = right ?? []
  return a.length === b.length && a.every((image, index) => image.data === b[index].data && image.mimeType === b[index].mimeType)
}

function keepLive(next: QueueItem[], live: Set<string>, seen: Set<string>): QueueItem[] {
  const out: QueueItem[] = []
  for (const item of next) {
    if (!live.has(item.id) || seen.has(item.id)) continue
    seen.add(item.id)
    out.push(item)
  }
  return out
}

export function planQueueRewrite(original: QueueState, next: QueueState): QueueState {
  const live = itemIds(original)
  const seen = new Set<string>()
  const planned: QueueState = {
    steering: keepLive(next.steering, live, seen),
    followUp: keepLive(next.followUp, live, seen)
  }
  for (const kind of ['steering', 'followUp'] as const) {
    for (const item of original[kind]) {
      if (seen.has(item.id) || !isSubagentNotice(item.text)) continue
      seen.add(item.id)
      planned[kind].push(item)
    }
  }
  return planned
}

export async function applyQueueRewrite(
  port: QueueRewritePort,
  original: QueueState,
  next: QueueState
): Promise<QueueRewriteResult> {
  const target = cloneQueue(planQueueRewrite(original, next))
  const backup = cloneQueue(original)
  if (sameQueue(original, target)) {
    port.publish(cloneQueue(original))
    return { ok: true }
  }
  const cleared = await port.clearQueue()
  if (!cleared.success) {
    return { ok: false, error: cleared.error || '清空队列失败', dropped: allItems(target) }
  }
  port.adoptCleared(cleared.steering, cleared.followUp)
  try {
    port.publish(target)
    await port.refill(target.steering, target.followUp)
    return { ok: true }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    try {
      const reset = await port.clearQueue()
      if (!reset.success) {
        return {
          ok: false,
          error: `队列编辑失败，且恢复失败：${reason}；${reset.error || '再次清空失败'}`,
          dropped: allItems(target)
        }
      }
      port.adoptCleared(reset.steering, reset.followUp)
      port.publish(backup)
      await port.refill(backup.steering, backup.followUp)
      return { ok: false, error: `队列编辑失败，原队列已恢复：${reason}` }
    } catch (restoreError) {
      const restoreReason = restoreError instanceof Error ? restoreError.message : String(restoreError)
      return {
        ok: false,
        error: `队列编辑失败，且恢复失败：${reason}；${restoreReason}`,
        dropped: allItems(target)
      }
    }
  }
}
