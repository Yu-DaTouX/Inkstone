/**
 * 队列快照的“消费”规则（D9）。
 *
 * 背景：pi 用 `queue_update` 推队列快照，但它把排队项拿去当**普通消息**
 * 消费（插话进当前回合、followUp 进下一轮）时不一定再推一次 —— 于是界面
 * 上会一直挂着「排队中」，直到下一条 queue_update 顺手抹掉。
 *
 * 触发时机是**消息真的出现**：主进程收到一条 user 消息，就说明队首那几条
 * 里有一条被消费了。这里只做“按原文摘掉一条”的判定，不碰进程与 IO，
 * 因此可以纯单测覆盖（`scripts/test-queue-items.mjs`）。
 */
import type { QueueItem, QueueState } from '../shared/ipc'

/**
 * 从队列里摘掉一条匹配的项。
 *
 * 规则：
 *   · 先 steering 再 followUp —— 同一个回合里 steering 会先被插进当前对话，
 *     followUp 要等回合结束；
 *   · 两边都可能出现相同文本（用户反复发同一句），所以只摘**第一条**匹配
 *     （FIFO），剩下的等同文本的消息再到；
 *   · 空文本不动任何东西（避免把“没有正文的消息”当成队列项）。
 *
 * @returns 摘除后的新状态；没有任何变化时返回 null（调用方据此决定要不要推）
 */
export function consumeQueuedItem(state: QueueState, text: string): QueueState | null {
  const want = (text ?? '').trim()
  if (!want) return null

  const take = (list: QueueItem[]): QueueItem[] | null => {
    const i = list.findIndex((item) => (item.text ?? '').trim() === want)
    if (i < 0) return null
    return [...list.slice(0, i), ...list.slice(i + 1)]
  }

  const steering = take(state.steering)
  if (steering) return { steering, followUp: state.followUp }
  const followUp = take(state.followUp)
  if (followUp) return { steering: state.steering, followUp }
  return null
}

/**
 * pi 的 `clear_queue` 结果 → 要放回输入框的文本。
 *
 * 顺序固定为 steering 在前：那是**先**被排进去的，回收后应当排在草稿前面，
 * 用户按原顺序改一遍就行。
 */
export function reclaimedTexts(cleared: {
  steering?: string[]
  followUp?: string[]
}): string[] {
  return [...(cleared.steering ?? []), ...(cleared.followUp ?? [])].filter((t) => !!t && t.trim().length > 0)
}
