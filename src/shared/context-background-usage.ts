/**
 * 后台模型调用的**真实用量账**。
 *
 * 为什么需要它：整理摘要、深度归纳、任务状态生成、交接归纳与标题生成
 * 都会各自发一次模型请求，但它们要么不经过会话循环（`ctx.modelRegistry.complete()`），
 * 要么跑在独立进程里（标题）。界面上能看到的只有主对话的用量 —— 于是
 * 「这个月到底是主对话花得多，还是后台在烧」只能靠猜。
 *
 * 口径边界：
 *   · `input` / `output` / `cacheRead` / `cacheWrite` / `cost` 全部来自**供应商返回的
 *     usage**，是实测值；
 *   · `estimatedInput` 是扩展侧请求体积估算，只用来核对「估算 vs 真实」的偏差，
 *     界面不得把它当成花费；
 *   · 命中率的分母是 `input + cacheRead`（与 `shared/turns.ts` 的 `cacheHitRate`
 *     同一口径）—— pi 报的 `input` 本身就是**未命中**的那部分。
 *
 * 账本由扩展与主进程各写一段（同一个文件、同一行格式），这里只做解析与聚合。
 */

export type ContextBackgroundCallKind = 'summary' | 'deep' | 'state' | 'handoff' | 'title'

/** 固定顺序：界面按这个顺序显示，不随日志先后抖动 */
export const CONTEXT_BACKGROUND_CALL_KINDS: ContextBackgroundCallKind[] = [
  'summary',
  'deep',
  'state',
  'handoff',
  'title'
]

export interface ContextBackgroundCallRecord {
  at: number
  kind: ContextBackgroundCallKind
  /** 请求是否真的发出并拿到了结果 */
  ok: boolean
  /** 未命中缓存的输入 token（供应商口径） */
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: number
  /** 扩展侧的请求体积估算；只用于与 `input` 对照 */
  estimatedInput?: number
  durationMs?: number
  model?: string
  /** 失败原因码 / 消息（`ok` 为 false 时） */
  error?: string
  /** 供应商有没有报 usage。缺报时上面的 token 数都是 0，不能当成"没花" */
  usageReported: boolean
}

export interface ContextBackgroundKindSummary {
  kind: ContextBackgroundCallKind
  calls: number
  failed: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: number
  estimatedInput: number
  /** 这一类里有多少次调用**没有**拿到供应商口径的 usage */
  missingUsage: number
  lastAt: number | null
  lastError: string | null
}

export interface ContextBackgroundUsageSummary {
  kinds: ContextBackgroundKindSummary[]
  /** 记账到的后台调用总数（含失败） */
  calls: number
  failed: number
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  totalTokens: number
  cost: number
  estimatedInput: number
  /** 命中率（%）；没有任何读数时为 null */
  cacheHitRate: number | null
  /** 有多少次后台调用没拿到 usage（有读数但为 0 与"缺报"必须分开看） */
  missingUsage: number
  lastAt: number | null
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function emptyKind(kind: ContextBackgroundCallKind): ContextBackgroundKindSummary {
  return {
    kind,
    calls: 0,
    failed: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: 0,
    estimatedInput: 0,
    missingUsage: 0,
    lastAt: null,
    lastError: null
  }
}

/**
 * 解析账本行：坏行跳过，认不出的 kind 也跳过 ——
 * 不能让一行写坏或未来新增的类型把整份统计变成空。
 */
export function parseBackgroundUsageLines(text: string, limit = 500): ContextBackgroundCallRecord[] {
  const out: ContextBackgroundCallRecord[] = []
  for (const line of String(text ?? '').split('\n')) {
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
    if (typeof kind !== 'string' || !(CONTEXT_BACKGROUND_CALL_KINDS as string[]).includes(kind)) continue
    const record: ContextBackgroundCallRecord = {
      at: num(item.at),
      kind: kind as ContextBackgroundCallKind,
      ok: item.ok === true,
      input: num(item.input),
      output: num(item.output),
      cacheRead: num(item.cacheRead),
      cacheWrite: num(item.cacheWrite),
      totalTokens: num(item.totalTokens),
      cost: num(item.cost),
      /* 老账本行没有这个字段：缺报是真信息，缺字段就当它报过 */
      usageReported: item.usageReported !== false
    }
    if (typeof item.estimatedInput === 'number' && Number.isFinite(item.estimatedInput) && item.estimatedInput >= 0) {
      record.estimatedInput = item.estimatedInput
    }
    if (typeof item.durationMs === 'number' && Number.isFinite(item.durationMs) && item.durationMs >= 0) {
      record.durationMs = item.durationMs
    }
    if (typeof item.model === 'string' && item.model) record.model = item.model.slice(0, 200)
    if (typeof item.error === 'string' && item.error) record.error = item.error.slice(0, 300)
    out.push(record)
  }
  /* 只保留最后 limit 条：账本是读数，不是无限增长的历史 */
  return limit > 0 && out.length > limit ? out.slice(-limit) : out
}

/** 每类分开累计 —— 混成一个「后台调用」就看不出是哪一步在花钱 */
export function summarizeBackgroundUsage(records: ContextBackgroundCallRecord[]): ContextBackgroundUsageSummary {
  const kinds = CONTEXT_BACKGROUND_CALL_KINDS.map(emptyKind)
  const byKind = new Map(kinds.map((item) => [item.kind, item]))
  let input = 0
  let cacheRead = 0
  let cacheWrite = 0
  let output = 0
  let totalTokens = 0
  let cost = 0
  let estimatedInput = 0
  let failed = 0
  let missingUsage = 0
  let lastAt: number | null = null

  for (const record of records) {
    const summary = byKind.get(record.kind)
    if (summary) {
      summary.calls += 1
      if (!record.ok) {
        summary.failed += 1
        if (record.error) summary.lastError = record.error
      }
      summary.input += record.input
      summary.output += record.output
      summary.cacheRead += record.cacheRead
      summary.cacheWrite += record.cacheWrite
      summary.totalTokens += record.totalTokens
      summary.cost += record.cost
      summary.estimatedInput += record.estimatedInput ?? 0
      if (!record.usageReported) summary.missingUsage += 1
      if (summary.lastAt === null || record.at >= summary.lastAt) summary.lastAt = record.at
    }
    if (!record.ok) failed += 1
    if (!record.usageReported) missingUsage += 1
    input += record.input
    output += record.output
    cacheRead += record.cacheRead
    cacheWrite += record.cacheWrite
    totalTokens += record.totalTokens
    cost += record.cost
    estimatedInput += record.estimatedInput ?? 0
    if (lastAt === null || record.at > lastAt) lastAt = record.at
  }

  const promptTotal = input + cacheRead
  return {
    kinds,
    calls: records.length,
    failed,
    input,
    cacheRead,
    cacheWrite,
    output,
    totalTokens,
    cost,
    estimatedInput,
    cacheHitRate: promptTotal > 0 ? (cacheRead / promptTotal) * 100 : null,
    missingUsage,
    lastAt
  }
}

/** 空统计（会话没有后台调用 / 账本读不到都用它，界面不必区分这两种情况） */
export function emptyBackgroundUsage(): ContextBackgroundUsageSummary {
  return summarizeBackgroundUsage([])
}
