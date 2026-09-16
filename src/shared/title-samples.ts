/**
 * 会话标题的**样本挑选**（纯逻辑）。
 *
 * 归纳进程只吃两句：**第一条**用户话与**最近一条**用户话。
 * 为什么不是全部：
 *   · 全部给过去，标题会变成“这段对话讲了 A、B、C、D”，等于没标题；
 *   · 只给第一条，聊到第四轮的会话标题会一直停在最初的话题上（用户报过）。
 *
 * 为什么单独成文件：这是「标题代表谁」的规则，之前散在
 * `agent.ts`（在内存里挑）与 `sessions.ts`（从 JSONL 里挑）两处 ——
 * 一处改了另一处不知道就会出现“新会话标题和旧会话标题口径不一样”。
 * 现在两份实现都是对同一个纯函数的不同输入（一个给界面消息，一个给文件行）。
 */

/** 挑样本需要的字段（界面消息与磁盘消息都能映射过来） */
export interface TitleSampleMessage {
  text: string
  images?: readonly { data: string; mimeType: string }[]
}

/** 图片消息没有文字，用占位符代替 —— 否则样本为空，标题永远生成不出来 */
export function titleSampleText(message: TitleSampleMessage): string {
  const text = message.text.trim()
  if (text) return text
  const n = message.images?.length ?? 0
  return n > 0 ? `[图片 ×${n}]` : ''
}

/**
 * 挑出要交给归纳进程的样本（按时间顺序）。
 *
 * 只有一条用户消息时返回一条（不要为了凑两条重复同一句；
 * 重复会让模型以为这句话出现了两次，从而在标题里强调它）。
 * 全是空白/无图的消息会被过滤掉，可能返回空数组 —— 调用方遇到空数组
 * 应当**不发起请求**并保留原标题。
 */
export function titleSamples(messages: readonly TitleSampleMessage[]): string[] {
  const usable = messages.map(titleSampleText).filter(Boolean)
  if (usable.length === 0) return []
  if (usable.length === 1) return [usable[0]]
  return [usable[0], usable[usable.length - 1]]
}

/**
 * 首条消息里的图片（最多一张）。
 *
 * 用户报过「首条消息带图时标题生成不了」：只有文字没有图片时，模型
 * 归纳不出任何东西。带一张就够 —— 标题是短请求，多塞图又慢又贵。
 */
export function titleSampleImages(
  messages: readonly TitleSampleMessage[]
): { data: string; mimeType: string }[] {
  for (const m of messages) {
    if (m.images?.length) return m.images.slice(0, 1).map((i) => ({ data: i.data, mimeType: i.mimeType }))
    if (titleSampleText(m)) break
  }
  return []
}
