import type { QueueEditOp, QueueItem, QueueState } from '../shared/ipc'
import { isSubagentNotice } from '../shared/subagent-notice'
import { isHostTextNotice } from '../shared/host-notice-text'
import { pick } from '../shared/ui-lang'

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
  adoptCleared(steering: string[], followUp: string[]): QueueState | void
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
      if (seen.has(item.id) || !(isSubagentNotice(item.text) || isHostTextNotice(item.text))) continue
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
  let target = cloneQueue(planQueueRewrite(original, next))
  let backup = cloneQueue(original)
  if (sameQueue(original, target)) {
    port.publish(cloneQueue(original))
    return { ok: true }
  }
  const cleared = await port.clearQueue()
  if (!cleared.success) {
    return { ok: false, error: cleared.error || pick('清空队列失败', 'Failed to clear the queue'), dropped: allItems(target) }
  }
  const adopted = port.adoptCleared(cleared.steering, cleared.followUp)
  if (adopted && Array.isArray(adopted.steering) && Array.isArray(adopted.followUp)) {
    target = cloneQueue(planQueueRewrite(adopted, next))
    const known = itemIds(original)
    for (const kind of ['steering', 'followUp'] as const) {
      for (const item of adopted[kind]) if (!known.has(item.id)) target[kind].push(item)
    }
    backup = cloneQueue(adopted)
  }
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
          error: pick(`队列编辑失败，且恢复失败：${reason}；${reset.error || '再次清空失败'}`, `Queue edit failed and restore failed: ${reason}; ${reset.error || 'clearing again failed'}`),
          dropped: allItems(target)
        }
      }
      port.adoptCleared(reset.steering, reset.followUp)
      port.publish(backup)
      await port.refill(backup.steering, backup.followUp)
      return { ok: false, error: pick(`队列编辑失败，原队列已恢复：${reason}`, `Queue edit failed; the original queue was restored: ${reason}`) }
    } catch (restoreError) {
      const restoreReason = restoreError instanceof Error ? restoreError.message : String(restoreError)
      return {
        ok: false,
        error: pick(`队列编辑失败，且恢复失败：${reason}；${restoreReason}`, `Queue edit failed and restore failed: ${reason}; ${restoreReason}`),
        dropped: allItems(target)
      }
    }
  }
}

export function planQueueEditOp(state: QueueState, op: QueueEditOp): { next: QueueState } | { error: string } {
  if (op.op === 'clear') return { next: { steering: [], followUp: [] } }
  const steering = state.steering.findIndex((item) => item.id === op.id)
  const kind = steering >= 0 ? 'steering' : state.followUp.some((item) => item.id === op.id) ? 'followUp' : undefined
  if (!kind) return { error: pick('这条排队消息已被接收或撤回', 'This queued message was already accepted or withdrawn') }
  const list = state[kind]
  const index = steering >= 0 ? steering : list.findIndex((item) => item.id === op.id)
  if (op.op === 'remove') return { next: { ...state, [kind]: list.filter((item) => item.id !== op.id) } }
  if (op.op === 'edit') {
    const text = op.text.trim()
    if (!text) return { error: pick('消息内容为空', 'Message is empty') }
    const items = [...list]
    items[index] = { ...items[index], text }
    return { next: { ...state, [kind]: items } }
  }
  const target = index + (op.direction === 'up' ? -1 : 1)
  if (target < 0 || target >= list.length) return { next: state }
  const items = [...list]
  const [moved] = items.splice(index, 1)
  items.splice(target, 0, moved)
  return { next: { ...state, [kind]: items } }
}
