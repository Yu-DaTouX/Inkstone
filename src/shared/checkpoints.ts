/**
 * 检查点（回退代码）的共享类型与匹配逻辑。
 *
 * 每次用户发出新一轮消息前，宿主给项目目录存一份文件快照（影子 git 仓库，见 main/checkpoints.ts）。
 * 界面据此在用户消息上给出「回退代码」：把项目文件恢复成发这条消息之前的样子。
 * 会话本身不回滚；要连对话一起回到那里，用「分支」。
 */

export interface CheckpointRecord {
  /** 记录 id（界面与主进程用它指代这次快照） */
  id: string
  /** 对应的会话（conversationId，没有则 sessionId） */
  sessionKey: string
  /** 快照时刻（发出消息前） */
  at: number
  /** 这一轮用户消息的指纹，用来在界面里认出它 */
  textHash: string
  /** 这一轮用户消息的开头（只用于确认框显示） */
  preview: string
  /** `turn`：发消息前的快照；`restore`：回退之前自动存的一份，用来撤销回退 */
  kind: 'turn' | 'restore'
}

export interface CheckpointChange {
  path: string
  /** M 已修改、A 回退后会被删掉（快照里没有这个文件）、D 回退后会被恢复（快照里有，现在没有） */
  status: 'M' | 'A' | 'D'
}

export interface CheckpointPreview {
  ok: boolean
  error?: string
  changes: CheckpointChange[]
  /** 变更总数（changes 最多列 200 条） */
  total: number
}

export interface CheckpointRestoreResult {
  ok: boolean
  error?: string
  /** 回退前自动存的快照；用它可以撤销这次回退 */
  undoId?: string
  restored: number
}

/** 与主进程一致的轻量指纹：只用来匹配，不是安全用途 */
export function textFingerprint(text: string): string {
  let h = 2166136261
  const s = text.replace(/\s+/g, ' ').trim()
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return `${(h >>> 0).toString(16)}:${s.length}`
}

/**
 * 找某条用户消息对应的检查点：
 * 指纹一致且发生在消息时间前后 10 分钟内，取时间最近的；
 * 没有指纹一致的就不猜（宁可不显示回退按钮，也不回退到错的地方）。
 */
export function matchCheckpoint(records: readonly CheckpointRecord[], text: string, timestamp: number | undefined): CheckpointRecord | null {
  const hash = textFingerprint(text)
  let best: CheckpointRecord | null = null
  let bestGap = Number.POSITIVE_INFINITY
  for (const record of records) {
    if (record.kind !== 'turn' || record.textHash !== hash) continue
    const gap = timestamp ? Math.abs(record.at - timestamp) : 0
    if (timestamp && gap > 10 * 60 * 1000) continue
    if (gap < bestGap) {
      best = record
      bestGap = gap
    }
  }
  return best
}
