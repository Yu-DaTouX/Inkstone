/**
 * 把宿主提问的记录合并成对话流里的用户消息（**纯函数**）。
 *
 * ══════════════════════════════════════════════════════════
 * 为什么要单独一层，而不是写进 `messages`
 * ══════════════════════════════════════════════════════════
 * `messages` 是 pi 会话的镜像（队列、最后一条用户消息、回合计时都依赖它）。
 * 问答记录是**界面新增的回放**，混进去会让那些判断把它当成真的用户发言。
 * 所以只在渲染前合成：`groupIntoTurns(messages)` 之前那一刻。
 *
 * 插入位置按**时间戳**找（第一条比问答更晚的消息之前）—— 问答发生在
 * 模型那一轮里，所以它天然落在「触发提问的回合」与「模型拿到答案后的回复」
 * 之间，与当时的真实顺序一致。
 *
 * 同一位置的相邻问答合并成一条消息（一轮里连问几个问题 = 一条消息里的几组
 * 问答），避免每问一次就多一个气泡。
 */
import type { QuestionLogEntry, UIMessage } from './ipc'

export function mergeQuestionLog(messages: UIMessage[], entries: QuestionLogEntry[]): UIMessage[] {
  if (!entries.length) return messages
  const out = [...messages]
  const sorted = [...entries].sort((a, b) => a.at - b.at)
  let last: UIMessage | null = null
  for (const entry of sorted) {
    const line = entry.answer ? `${entry.question}\n\n${entry.answer}` : entry.question
    /* 第一条时间戳更晚的真实消息之前 = 当时的位置 */
    let index = out.length
    for (let i = 0; i < out.length; i += 1) {
      const at = out[i].timestamp
      if (typeof at === 'number' && at > entry.at) {
        index = i
        break
      }
    }
    /* 上一条虚拟消息刚好就在插入点前面 → 它们是同一轮的连续提问，合并 */
    if (last && out[index - 1] === last) {
      last.text = `${last.text}\n\n${line}`
      continue
    }
    const msg: UIMessage = {
      id: `qlog:${entry.id}`,
      role: 'user',
      question: true,
      text: line,
      timestamp: entry.at
    }
    out.splice(index, 0, msg)
    last = msg
  }
  return out
}
