/**
 * 三类整理动作的共用契约（实施-11 C-2b）。
 *
 * 为什么需要它：`tool-sweep`（轻量整理）与 `episode-fold`（状态刷新）
 * **不产生 pi 的 `compaction_*` 事件** —— 宿主完全没有别的途径知道
 * “这一轮到底动没动上下文”。所以由扩展把动作写进账本，宿主读出来，
 * 界面把三类分开显示，而不是混成一句“上下文被整理过”。
 *
 * 边界：账本只记**动作口径**（做了什么、动了多少条、省了多少估算 token、
 * 为什么没做），不复述消息正文 —— 它是诊断，不是第二份转录。
 * `savedTokens` 是扩展侧估算，**不是**供应商口径，界面不得把它说成实测。
 */

export type ContextActionKind = 'tool-sweep' | 'episode-fold' | 'compaction'

/**
 * 账本**能记**的两类：`tool-sweep`（轻量整理）与 `episode-fold`（状态刷新）。
 *
 * 为什么没有 `compaction`：整轮压缩有 pi 自己的 `compaction_*` 事件，
 * 宿主本来就有权威口径 —— 再写一份只会让两处数字对不上。
 * 界面上三类仍分开显示：两类读账本，第三类读 pi 事件。
 */
export const RECORDED_ACTION_KINDS: ContextActionKind[] = ['tool-sweep', 'episode-fold']

/** 固定顺序：界面按这个顺序显示，不随日志先后抖动 */
export const CONTEXT_ACTION_KINDS: ContextActionKind[] = ['tool-sweep', 'episode-fold', 'compaction']

export interface ContextActionRecord {
  at: number
  kind: ContextActionKind
  /** `applied` / `injected` / `skipped` / `rejected` / `failed` */
  status: string
  /** 没做或做不下去的原因（如 `below-min-reclaim`、`ledger-unavailable`） */
  reason?: string
  /** 被整理的条目数（tombstone 数 / 注入块数） */
  reclaimed?: number
  /** 这一动作省下的**估算** token（不是供应商口径） */
  savedTokens?: number
  /** 注入 / 生成内容的 token 量（episode-fold） */
  tokens?: number
  /** episode-fold 的 freshness 档位（fresh / stale / …） */
  freshness?: string
}

export interface ContextActionKindSummary {
  kind: ContextActionKind
  count: number
  /** `applied` + `injected` */
  applied: number
  /** `skipped` + `rejected` */
  skipped: number
  lastAt: number | null
  lastStatus: string | null
  lastReason: string | null
  reclaimed: number
  savedTokens: number
}

export interface ContextActionSummary {
  kinds: ContextActionKindSummary[]
  total: number
  lastAt: number | null
}

function emptyKind(kind: ContextActionKind): ContextActionKindSummary {
  return {
    kind,
    count: 0,
    applied: 0,
    skipped: 0,
    lastAt: null,
    lastStatus: null,
    lastReason: null,
    reclaimed: 0,
    savedTokens: 0
  }
}

/**
 * 解析账本行：坏行跳过，不因为一行写坏就丢掉整份统计。
 * 只留**认得出**的记录 —— 未来新增的 kind 由本文件扩展，而不是让界面碰运气。
 */
export function parseActionLines(text: string, limit = 300): ContextActionRecord[] {
  const out: ContextActionRecord[] = []
  const lines = String(text ?? '').split('\n')
  for (const line of lines) {
    const raw = line.trim()
    if (!raw) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object') continue
    const item = parsed as Record<string, unknown>
    const kind = item.kind
    if (typeof kind !== 'string' || !(CONTEXT_ACTION_KINDS as string[]).includes(kind)) continue
    const at = typeof item.at === 'number' && Number.isFinite(item.at) ? item.at : 0
    const status = typeof item.status === 'string' && item.status ? item.status : 'unknown'
    const record: ContextActionRecord = { at, kind: kind as ContextActionKind, status }
    if (typeof item.reason === 'string' && item.reason) record.reason = item.reason
    if (typeof item.reclaimed === 'number' && Number.isFinite(item.reclaimed)) record.reclaimed = item.reclaimed
    if (typeof item.savedTokens === 'number' && Number.isFinite(item.savedTokens)) record.savedTokens = item.savedTokens
    if (typeof item.tokens === 'number' && Number.isFinite(item.tokens)) record.tokens = item.tokens
    if (typeof item.freshness === 'string' && item.freshness) record.freshness = item.freshness
    out.push(record)
  }
  /* 只保留最后 limit 条：账本是诊断，不是无限增长的历史 */
  return limit > 0 && out.length > limit ? out.slice(-limit) : out
}

/** 三类分开累计 —— 不合并成一个“整理次数”，那正是这次要修的问题 */
export function summarizeActions(records: ContextActionRecord[]): ContextActionSummary {
  const kinds = RECORDED_ACTION_KINDS.map(emptyKind)
  const byKind = new Map(kinds.map((item) => [item.kind, item]))
  const reasonAt: Record<string, number> = {}
  let lastAt: number | null = null

  for (const record of records) {
    const summary = byKind.get(record.kind)
    if (!summary) continue
    summary.count += 1
    if (record.status === 'applied' || record.status === 'injected') summary.applied += 1
    if (record.status === 'skipped' || record.status === 'rejected') summary.skipped += 1
    if (typeof record.reclaimed === 'number') summary.reclaimed += record.reclaimed
    if (typeof record.savedTokens === 'number') summary.savedTokens += record.savedTokens
    if (summary.lastAt === null || record.at >= summary.lastAt) {
      summary.lastAt = record.at
      summary.lastStatus = record.status
    }
    /*
     * 「最近的原因」只认**带原因的那条**（不是最近那条）。
     * 否则界面上会出现「跳过 2 次（最近：未记原因）」—— 而账本里其实
     * 记着原因，只是最近一条是“做了”的记录（它没有 reason）。
     */
    if (record.reason && (reasonAt[record.kind] === undefined || record.at >= reasonAt[record.kind])) {
      summary.lastReason = record.reason
      reasonAt[record.kind] = record.at
    }
    if (lastAt === null || record.at > lastAt) lastAt = record.at
  }

  return { kinds, total: records.length, lastAt }
}
