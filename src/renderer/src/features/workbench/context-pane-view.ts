/**
 * 工作区「上下文」页签的只读投影（纯函数，可单测）。
 *
 * 权威边界与输入框左下角的上下文环一致：**总量只认 `stats.contextUsage.tokens`**
 *（Agent 报的），分类占比才由 `state/context-breakdown.ts` 按当前可见消息估算。
 * 没有可信总量（模型未对齐 / pi 还没报）时返回 `known=false`，界面显示 `—`，
 * 绝不按窗口编一个百分比。
 *
 * 「文件 / 工具结果占用」是**估算的明细**，不是供应商口径：
 *   · 工具结果 —— 从 `toolCalls` 的原始参数与输出文本估算，与分类里的 `tools` 同源；
 *   · 文件与图片 —— 按消息附件的图片数乘固定估算值，已包含在 `user` / `tools` 分类里，
 *     这里单独列出来只是让用户知道「附件占了多少」，不重复计入总量。
 */
import type { SessionStats, SessionState, UIMessage } from '../../../../shared/ipc'
import { contextBreakdown, type ContextSlice } from '../../state/context-breakdown'

/**
 * 一张图片的估算 token。
 *
 * 必须与 `state/context-breakdown.ts` 的 `IMAGE_TOKENS` 一致；那个文件不属本模块，
 * 无法导出共享常量，所以这里保留同值并注明来源。
 */
const IMAGE_TOKENS = 1200

export interface ContextUsageSummary {
  /** 总量与窗口都可信时才为 true */
  known: boolean
  tokens: number
  windowSize: number
  percent: number | null
  tone: 'ok' | 'warn' | 'err'
  /** `stats.contextUsage` 与当前模型对齐（旧快照不能冒充当前值） */
  matchesModel: boolean
  /** 压缩后 pi 还没报新用量：界面写「待测」而不是 0 */
  afterCompactUnknown: boolean
}

export interface ContextOccupancyRow {
  id: 'tools' | 'files'
  /** 估算 token；不是供应商口径 */
  tokens: number
  count: number
}

export interface ContextPaneData {
  usage: ContextUsageSummary
  /** 只在 `usage.known` 时非空；否则界面不画构成条 */
  slices: ContextSlice[]
  /** 只在 `usage.known` 时非空 */
  occupancy: ContextOccupancyRow[]
  /** 最近一次压缩的起点；构成只统计它之后的消息 */
  since?: number
}

/** 复用上下文环的模型对齐规则：`modelKey` 与当前模型不一致的旧快照不可信。 */
export function contextUsageSummary(
  session: Pick<SessionState, 'model' | 'lastCompaction'> | null,
  stats: Pick<SessionStats, 'contextUsage'> | null
): ContextUsageSummary {
  const usage = stats?.contextUsage
  const modelKey = session?.model ? `${session.model.provider}/${session.model.id}` : undefined
  const matchesModel = !!usage && (!usage.modelKey || usage.modelKey === modelKey)
  const reported = matchesModel ? usage?.contextWindow : undefined
  const windowSize =
    typeof reported === 'number' && Number.isFinite(reported) && reported > 0
      ? reported
      : session?.model?.contextWindow ?? 0
  const known = matchesModel && typeof usage?.tokens === 'number' && windowSize > 0
  const tokens = known ? (usage!.tokens as number) : 0
  const percent = known ? (tokens / windowSize) * 100 : null
  const tone: 'ok' | 'warn' | 'err' =
    percent !== null && percent >= 95 ? 'err' : percent !== null && percent >= 80 ? 'warn' : 'ok'
  return {
    known,
    tokens,
    windowSize,
    percent,
    tone,
    matchesModel,
    afterCompactUnknown: matchesModel && usage?.tokens === null
  }
}

/** 最近一次已完成压缩的起点；没有就不按时间过滤。 */
export function contextSince(session: Pick<SessionState, 'lastCompaction'> | null): number | undefined {
  return session?.lastCompaction?.status === 'completed' ? session.lastCompaction.startedAt : undefined
}

/** 把 token 数缩成 `383.8k / 1M` 一类的短写法；只用于展示。 */
export function shortTokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`
  if (n >= 1000) return `${+(n / 1000).toFixed(1)}k`
  return String(n)
}

/** 文件 / 工具结果的估算明细。没有可信总量时由调用方跳过。 */
export function contextOccupancy(
  messages: readonly UIMessage[],
  slices: readonly ContextSlice[],
  since?: number
): ContextOccupancyRow[] {
  let toolCount = 0
  let fileCount = 0
  for (const m of messages) {
    if (since && (m.timestamp ?? 0) < since) continue
    if (m.role === 'user') fileCount += m.images?.length ?? 0
    toolCount += m.toolCalls?.length ?? 0
  }
  const tools = slices.find((s) => s.id === 'tools')?.tokens ?? 0
  return [
    { id: 'tools', tokens: tools, count: toolCount },
    { id: 'files', tokens: fileCount * IMAGE_TOKENS, count: fileCount }
  ]
}

/** 页签一次渲染需要的全部只读数据。 */
export function contextPaneData(input: {
  session: Pick<SessionState, 'model' | 'lastCompaction'> | null
  stats: Pick<SessionStats, 'contextUsage'> | null
  messages: readonly UIMessage[]
}): ContextPaneData {
  const usage = contextUsageSummary(input.session, input.stats)
  const since = contextSince(input.session)
  if (!usage.known) return { usage, slices: [], occupancy: [], since }
  const slices = contextBreakdown(input.messages, usage.tokens, since)
  return { usage, slices, occupancy: contextOccupancy(input.messages, slices, since), since }
}
