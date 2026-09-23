/**
 * 子代理累计 usage（实施-11 H-10b）。
 *
 * 真源是主进程按 **消息 id** 收到的 usage 快照：
 *   · `message_update` 里的是**累积值**，`message_end` 是最终值 —— 同一 id 只保留
 *     最后一份，所以流式增量不会和 final 重复相加；
 *   · 不同消息的快照才相加；重放同一 id 不会翻倍。
 *
 * 持久化的是按消息去重后的快照之和，**不依赖有界 transcript**（转录被截尾后
 * 统计仍然完整）。一条 usage 都没收到时返回 `null`，界面显示未知，不把估算当真实。
 */
import type { SubagentUsageTotals, Usage } from './ipc'

export type { SubagentUsageTotals }

/** 按消息 id 保存最后一次 usage 快照（输入侧不可变，便于测试） */
export type UsageSnapshots = Record<string, Usage>

export function ingestUsageSnapshot(
  snapshots: UsageSnapshots,
  messageId: string,
  usage: Usage
): UsageSnapshots {
  if (!messageId) return snapshots
  return { ...snapshots, [messageId]: usage }
}

const EMPTY: SubagentUsageTotals = {
  input: null,
  output: null,
  cacheRead: null,
  cacheWrite: null,
  totalTokens: null,
  cost: null,
  reportedMessages: 0
}

export function accumulateUsage(snapshots: UsageSnapshots): SubagentUsageTotals {
  const entries = Object.values(snapshots)
  if (entries.length === 0) return { ...EMPTY }
  let input = 0
  let output = 0
  let cacheRead = 0
  let cacheWrite = 0
  let totalTokens = 0
  let cost = 0
  for (const u of entries) {
    input += u.input
    output += u.output
    cacheRead += u.cacheRead
    cacheWrite += u.cacheWrite
    totalTokens += u.totalTokens
    cost += u.cost
  }
  return { input, output, cacheRead, cacheWrite, totalTokens, cost, reportedMessages: entries.length }
}

/**
 * 旧记录兼容：已有持久化统计直接读；没有则视为未知（不从截尾 transcript 反推）。
 */
export function normalizeSubagentUsage(value: unknown): SubagentUsageTotals | undefined {
  if (!value || typeof value !== 'object') return undefined
  const input = value as Partial<SubagentUsageTotals>
  if (typeof input.reportedMessages !== 'number' || input.reportedMessages <= 0) return undefined
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return {
    input: num(input.input),
    output: num(input.output),
    cacheRead: num(input.cacheRead),
    cacheWrite: num(input.cacheWrite),
    totalTokens: num(input.totalTokens),
    cost: num(input.cost),
    reportedMessages: input.reportedMessages
  }
}
