import { useStore } from '../state/store'

/**
 * 分叉（branch）的两个入口 —— 从 pi 的会话树里创建新分支。
 *
 * 为什么单独抽成一个模块：左栏（会话行）与对话区（每条用户消息上的
 * 分支按钮）都要用它。原先它住在 Rail.tsx 里，而 TurnView 得从
 * `./Rail` import —— 对话区依赖左栏，是把两个区域绑在一起的坏味道。
 *
 * ⚠️ entryId 必须由 pi 给（get_messages 不带 entry id），
 *    所以统一走 get_fork_messages 取，**不从 DOM 猜**。
 */

/** 从最后一条用户消息分叉（左栏会话行用） */
export async function forkLatest(): Promise<void> {
  const points = await window.yan.forkPoints()
  const last = points[points.length - 1]
  if (!last) return
  await useStore.getState().fork(last.entryId)
}

/**
 * 从「文本等于这一条」的用户消息分叉（消息上的分支按钮用）。
 *
 * 为什么按文本匹配：pi 的 get_fork_messages 只回 `{entryId, text}`，
 * 而界面上的消息 id 是归一化后的 id（两套 id 不对应）。
 * 倒序找第一条文本相同的 —— 同一段话被发过两次时取最近的。
 */
export async function forkFromText(text: string): Promise<void> {
  const points = await window.yan.forkPoints()
  const hit = [...points].reverse().find((p) => p.text.trim() === text.trim())
  if (!hit) return
  await useStore.getState().fork(hit.entryId)
}
