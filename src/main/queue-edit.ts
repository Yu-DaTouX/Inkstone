import type { QueueItem, QueueState } from '../shared/ipc'

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

export async function applyQueueRewrite(
  port: QueueRewritePort,
  original: QueueState,
  next: QueueState
): Promise<QueueRewriteResult> {
  const target = cloneQueue(next)
  const backup = cloneQueue(original)
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
