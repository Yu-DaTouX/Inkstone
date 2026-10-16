/**
 * 队列编辑 / 重排的编排（WP-24b）。
 *
 * pi 没有「改一条排队消息」或「调整队列顺序」的原生命令，只有 `clear_queue`
 * 一次清空。所以统一走：clear_queue 取回实况 → 按渲染端算出的目标顺序重新入队。
 *
 * 这里只做与 Electron / pi 无关的编排：清空、采用实况、重建、失败恢复。真正的
 * RPC、队列身份与推送由 `AgentController` 通过 `QueueRewritePort` 提供（见
 * agent.ts 的 `rewriteQueue`），因此本模块能在 Node 里用假端口单测。
 *
 * 失败语义（渲染端「不丢内容」依赖它）：
 *   · 重建中途失败会先尝试把**原队列**整批恢复；
 *   · 恢复成功 → 内容仍在 pi 队列里，`dropped` 为空；
 *   · 恢复也失败 → 把目标队列整批装进 `dropped`，渲染端必须回填输入框。
 */
import type { QueueItem, QueueState } from '../shared/ipc'

export interface QueueRewriteResult {
  ok: boolean
  error?: string
  /** 重建失败且原队列也没能恢复时，渲染端必须把这些内容放回输入框，保证不丢。 */
  dropped?: QueueItem[]
}

export interface ClearedQueue {
  success: boolean
  error?: string
  steering: string[]
  followUp: string[]
}

/** AgentController 私有队列动作的最小端口。 */
export interface QueueRewritePort {
  /** pi 原生 `clear_queue`：一次清空并返回被清出的文本。 */
  clearQueue(): Promise<ClearedQueue>
  /** 把 clear_queue 的实况作为权威快照落在本地（清掉身份映射）。 */
  adoptCleared(steering: string[], followUp: string[]): void
  /** 用目标队列替换本地快照并推送。 */
  publish(next: QueueState): void
  /** 逐条按类型重新入队；中途失败必须抛出，交给本模块恢复。 */
  refill(steering: QueueItem[], followUp: QueueItem[]): Promise<void>
}

/** 深拷贝队列项，避免恢复路径与目标路径共享同一份对象。 */
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

/**
 * 执行一次队列重建。
 *
 * @param port     AgentController 提供的队列动作端口
 * @param original 操作前的主进程队列快照，用于失败恢复
 * @param next     渲染端算出的目标顺序
 */
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
