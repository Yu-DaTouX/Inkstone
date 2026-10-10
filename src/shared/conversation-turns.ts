/**
 * 会话消息 → 轮次投影（实施-26 R1）。
 *
 * 会话地图原来只有「一个会话 = 一个节点」。轮次层要的是
 * 「一轮问答 = 一张卡」，本模块就是那一层的**纯逻辑**（无 DOM、无 Electron、
 * 无文件系统），输入 `UIMessage[]`、输出 `ConversationTurn[]`。
 *
 * 切分口径（见实施-26 §3.1）：
 *   · `user` 起一轮；其后的 `assistant` / `bash` / 工具结果容器归入该轮
 *   · 同一 `turnTiming.logicalTurnId` 的消息属于同一轮 —— 自动继续会在同一
 *     回合里再写一条 user 消息，那时**不能**另起一轮
 *   · 没有 `logicalTurnId` 的旧历史按 role 顺序退化，轮 id 用首条 user 的合成 id
 *   · 两者冲突（role 顺序想说新轮、但 lid 说同一轮）时**以 lid 为准**
 *   · 前导的非 user 消息不构成轮（没有问题的回答不是「一轮问答」）
 *
 * 工具往返不单独成卡：`UIMessage.toolCalls` 本来就挂在消息上，
 * 这里只汇总条数，成败由卡片按 `status` 渲染。
 *
 * 有损读取（截断 / 跳过）由调用方按 `ReadResult.truncated` 标注，
 * 本模块看不见也不需要看见。
 */
import type { TurnTerminalReason, UIMessage } from './ipc'
import { isSubagentNotice } from './subagent-notice'

export interface ConversationTurn {
  /** 稳定轮次身份：有 `logicalTurnId` 用它，否则 `turn:<首条 user 的 id>` */
  id: string
  /** 宿主记录的回合身份（同一回合的所有消息共用一个值） */
  logicalTurnId?: string
  /** 本轮的问题（首条 user 消息） */
  question: UIMessage
  /** 本轮完整消息序列：问题 → 过程 → 答案 */
  messages: UIMessage[]
  /**
   * 最终答案：轮内**最后一条有正文**的 assistant 消息。
   *
   * 不能简单取「最后一条 assistant」—— 工具往返中的 assistant 可能只有
   * thinking 与 toolCalls、没有正文，把它当答案会显示一张空卡。
   */
  answer?: UIMessage
  /** 工具往返条数（含 bash 直执行） */
  toolCalls: number
  /** 终止原因（同轮共享；取轮内最后一条带 `turnTiming` 的消息） */
  terminalReason?: TurnTerminalReason
  /**
   * 这一轮没有正常收尾：没有最终答案，或被 stopped / interrupted / failed 终止。
   *
   * 中断轮**必须可见** —— 不能因为「没有最终回答」就被过滤掉。
   */
  incomplete: boolean
  startedAt?: number
  endedAt?: number
}

interface Acc {
  question: UIMessage
  messages: UIMessage[]
  logicalTurnId?: string
}

/**
 * 把消息序列切成一轮一轮。
 *
 * 无 `user` 消息的会话返回 `[]`（正常，不报错）。
 */
export function buildConversationTurns(messages: UIMessage[]): ConversationTurn[] {
  const accs: Acc[] = []
  let current: Acc | null = null

  for (const m of messages) {
    if (m.role === 'user' && isSubagentNotice(m.text)) continue
    const lid = m.turnTiming?.logicalTurnId

    if (m.role === 'user') {
      /*
       * 同一回合的续写（自动继续）在 lid 上表现为同一轮。
       * 旧历史没有 lid，任何 user 都另起一轮 —— 那是唯一可用的信号。
       *
       * 反向边界：当轮已有 lid、后续消息却丢了 lid（元数据缺失的尾巴）时，
       * 新的 user 仍按 role 顺序另起一轮 —— 不把「没有身份的新问题」
       * 硬塞进上一轮。
       */
      const sameTurn =
        !!current && !!lid && !!current.logicalTurnId && lid === current.logicalTurnId
      if (!current || !sameTurn) {
        current = { question: m, messages: [m], ...(lid ? { logicalTurnId: lid } : {}) }
        accs.push(current)
        continue
      }
    }

    // 前导的非 user 消息：没有问题的回答，不成轮
    if (!current) continue

    current.messages.push(m)
    if (lid && !current.logicalTurnId) current.logicalTurnId = lid
  }

  return accs.map((a) => {
    const msgs = a.messages
    const answer = [...msgs].reverse().find((m) => m.role === 'assistant' && m.text.trim())
    const timings = msgs.filter((m) => m.turnTiming)
    const lastTiming = timings[timings.length - 1]?.turnTiming
    const terminalReason = lastTiming?.terminalReason
    const startedAt = lastTiming?.startedAt ?? msgs[0]?.timestamp
    const endedAt = lastTiming?.endedAt ?? msgs[msgs.length - 1]?.timestamp
    const incomplete =
      !answer ||
      terminalReason === 'stopped' ||
      terminalReason === 'interrupted' ||
      terminalReason === 'failed'

    return {
      id: a.logicalTurnId ?? `turn:${a.question.id}`,
      ...(a.logicalTurnId ? { logicalTurnId: a.logicalTurnId } : {}),
      question: a.question,
      messages: msgs,
      ...(answer ? { answer } : {}),
      toolCalls: msgs.reduce((n, m) => n + (m.toolCalls?.length ?? 0), 0),
      ...(terminalReason ? { terminalReason } : {}),
      incomplete,
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(endedAt !== undefined ? { endedAt } : {})
    }
  })
}
