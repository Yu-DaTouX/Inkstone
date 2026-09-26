/**
 * 上下文装配（实施-25 P05 / T05-3）—— 契约与纯逻辑。
 *
 * ══════════════════════════════════════════════════════════════════
 * 它装配什么，不装配什么
 * ══════════════════════════════════════════════════════════════════
 * 设计稿的顺序是：**当次要求 → 任务/学习阶段 → 必要来源片段 →
 * 相关空间知识 → 少量偏好**。这里把它写成可预算、可裁剪、可检查的片段列表。
 *
 * 三条边界：
 *   · **不每轮全量载入**：来源片段有独立预算（不超过总预算的 60%），
 *     骨架分区（任务 / 空间 / 偏好）永远先占位，不会被一堆资料挤没；
 *   · **完整原文保持可读**：这里只放片段，并且每条引用都带
 *     `sourceId + version + 字符区间`，界面据此跳回原文（T05-3 / 验收）；
 *   · **不读盘**：本模块是纯函数，读资料库的事在 `main/context-assembler.ts`。
 *
 * ⚠️ 与 `context-policy.ts` 不是一回事：那是 pi 的**上下文预算与压缩**策略
 * （N21），管的是「什么时候压、压多少」；这里管的是「这一轮该带哪些内容」。
 * 两者都会提到「预算」，但一个约束 pi 的窗口，一个约束我们注入的分区。
 */

import type { AgentActivity } from './agent-profile'
import type { SourceReference } from './library'

export type ContextSectionId = 'requirement' | 'task' | 'sources' | 'space' | 'preference'

/** 字符区间。`end` 不含（与 `slice` 一致）。 */
export interface CitationLocator {
  start: number
  end: number
}

/**
 * 一条来源引用。
 *
 * `locator` 是「跳回原文」的锚点：**只对文本类资料有意义**（解析出的正文
 * 有稳定字符位置）。附件 / 网页没有正文时省略，界面按引用本身打开。
 */
export interface ContextCitation {
  sourceId: string
  version: number
  title: string
  locator?: CitationLocator
}

export interface ContextFragment {
  section: ContextSectionId
  heading: string
  text: string
  citations: ContextCitation[]
}

export interface ContextAssembly {
  activity: AgentActivity
  fragments: ContextFragment[]
  citations: ContextCitation[]
  budget: {
    limit: number
    used: number
    /** 完全没进上下文的候选片段数（主要是来源）。 */
    dropped: number
    /** 被截断的片段数（内容在，但只带了前面一部分）。 */
    truncated: number
  }
}

/** 默认注入预算（字符）。够放任务骨架 + 几段来源，又不至于塞满窗口。 */
export const DEFAULT_CONTEXT_BUDGET = 6000
/** 来源分区最多占总预算的比例（防止资料挤走骨架）。 */
export const SOURCES_BUDGET_RATIO = 0.6
/** 单条来源片段的最小可用长度；剩余预算低于它就整条不带（半句话没有用）。 */
export const MIN_SOURCE_CHARS = 200

export interface ContextSourceInput {
  ref: SourceReference
  title: string
  /** 要带进上下文的正文。完整正文由调用方按需截取，这里再按预算裁。 */
  text: string
  /** 这段正文在原文中的起点字符偏移（默认 0）。 */
  start?: number
}

export interface ContextAssemblyInput {
  activity: AgentActivity
  /** 当次用户要求（通常为空 —— 用户消息本就是 prompt 的一部分）。 */
  requirement?: string
  /** 任务 / 学习阶段的摘要（宿主从 goal / task-plan 取）。 */
  task?: string
  /** 必要来源片段（宿主从资料库的会话引用取）。 */
  sources?: ContextSourceInput[]
  /** 相关空间知识（空间名称 / 描述 / 已归档主题）。 */
  space?: string
  /** 少量偏好（语言、详细程度、推进方式）。 */
  preference?: string
}

const SECTION_HEADINGS: Record<ContextSectionId, string> = {
  requirement: '当次要求',
  task: '任务与阶段',
  sources: '来源片段',
  space: '相关空间',
  preference: '偏好'
}

/** 片段之间的连接符（预算按最终渲染文本算，所以这里一起计入）。 */
const JOIN = '\n'

function clip(text: string, max: number): { text: string; truncated: boolean } {
  if (max <= 0) return { text: '', truncated: text.length > 0 }
  if (text.length <= max) return { text, truncated: false }
  return { text: text.slice(0, max), truncated: true }
}

/**
 * 装配本轮上下文（纯函数）。
 *
 * 输出顺序 = 设计稿顺序：**当次要求 → 任务/阶段 → 来源片段 → 空间 → 偏好**。
 * 但预算分配先保障骨架：先把前置（要求/任务）与后置（空间/偏好）两段
 * 按预算裁好，来源再用剩下的额度（且不超过总预算的 60%）——
 * 这样一堆资料不会把「任务与阶段」挤没，同时输出顺序仍是设计稿那一条。
 *
 * 完全放不下的来源计入 `dropped`，被裁短的片段计入 `truncated` ——
 * 宿主据此能说出「这一轮带了 3/5 条来源」，而不是静默少带。
 */
export function assembleContext(
  input: ContextAssemblyInput,
  budget: number = DEFAULT_CONTEXT_BUDGET
): ContextAssembly {
  const limit = Number.isFinite(budget) && budget > 0 ? Math.floor(budget) : DEFAULT_CONTEXT_BUDGET
  const citations: ContextCitation[] = []
  let dropped = 0
  let truncated = 0
  let skeletonChars = 0

  type SkeletonItem = { section: ContextSectionId; heading: string; text: string }
  const leading: SkeletonItem[] = []
  const trailing: SkeletonItem[] = []
  if (input.requirement?.trim()) {
    leading.push({ section: 'requirement', heading: SECTION_HEADINGS.requirement, text: input.requirement.trim() })
  }
  if (input.task?.trim()) {
    leading.push({ section: 'task', heading: SECTION_HEADINGS.task, text: input.task.trim() })
  }
  if (input.space?.trim()) {
    trailing.push({ section: 'space', heading: SECTION_HEADINGS.space, text: input.space.trim() })
  }
  if (input.preference?.trim()) {
    trailing.push({ section: 'preference', heading: SECTION_HEADINGS.preference, text: input.preference.trim() })
  }

  const clipSkeleton = (items: SkeletonItem[]): ContextFragment[] => {
    const out: ContextFragment[] = []
    for (const item of items) {
      const clipped = clip(item.text, Math.max(0, limit - skeletonChars))
      if (!clipped.text) {
        dropped++
        continue
      }
      out.push({ section: item.section, heading: item.heading, text: clipped.text, citations: [] })
      skeletonChars += clipped.text.length
      if (clipped.truncated) truncated++
    }
    return out
  }

  const leadingFragments = clipSkeleton(leading)
  const trailingFragments = clipSkeleton(trailing)

  const sourcesBudget = Math.min(Math.max(0, limit - skeletonChars), Math.floor(limit * SOURCES_BUDGET_RATIO))
  const sourceFragments: ContextFragment[] = []
  let sourceUsed = 0
  for (const source of input.sources ?? []) {
    const left = sourcesBudget - sourceUsed
    if (left < Math.min(MIN_SOURCE_CHARS, source.text.length)) {
      dropped++
      continue
    }
    const clipped = clip(source.text, left)
    const start = source.start ?? 0
    const citation: ContextCitation = {
      sourceId: source.ref.sourceId,
      version: source.ref.version,
      title: source.title,
      ...(clipped.text.length > 0 ? { locator: { start, end: start + clipped.text.length } } : {})
    }
    sourceFragments.push({
      section: 'sources',
      heading: SECTION_HEADINGS.sources,
      text: clipped.text,
      citations: [citation]
    })
    citations.push(citation)
    sourceUsed += clipped.text.length
    if (clipped.truncated) truncated++
  }

  return {
    activity: input.activity,
    fragments: [...leadingFragments, ...sourceFragments, ...trailingFragments],
    citations,
    budget: { limit, used: skeletonChars + sourceUsed, dropped, truncated }
  }
}

/* ------------------------------------------------------------------ *
 * 引用标注：渲染与解析必须是一对（界面「跳回原文」靠它）
 * ------------------------------------------------------------------ */

/** 引用标注：`⟦<sourceId>@<version>#<start>-<end>⟧`；无区间时省略 `#...`。 */
export function citationToken(citation: ContextCitation): string {
  const loc = citation.locator ? `#${citation.locator.start}-${citation.locator.end}` : ''
  return `⟦${citation.sourceId}@${citation.version}${loc}⟧`
}

const TOKEN_RE = /⟦([^@⟧]+)@(\d+)(?:#(\d+)-(\d+))?⟧/g

/** 从文本里解析回引用标注（`renderContextSection` 的逆运算）。 */
export function parseCitationTokens(text: string): ContextCitation[] {
  const out: ContextCitation[] = []
  if (typeof text !== 'string') return out
  TOKEN_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = TOKEN_RE.exec(text)) !== null) {
    const [, sourceId, version, start, end] = match
    const citation: ContextCitation = { sourceId, version: Number(version), title: sourceId }
    if (start !== undefined && end !== undefined) {
      citation.locator = { start: Number(start), end: Number(end) }
    }
    out.push(citation)
  }
  return out
}

/**
 * 渲染成注入给模型的分区文本。
 *
 * 返回 `null` = 没有任何内容可注入（**不注入空分区**，否则系统提示里会出现
 * 一个只剩标题的「来源片段」，看起来像宿主出了错）。
 */
export function renderContextSection(assembly: ContextAssembly): string | null {
  const lines: string[] = []
  for (const fragment of assembly.fragments) {
    const body = fragment.text.trim()
    if (!body) continue
    lines.push(`### ${fragment.heading}`)
    if (fragment.section === 'sources' && fragment.citations.length > 0) {
      for (const citation of fragment.citations) {
        lines.push(`【来源】${citation.title} ${citationToken(citation)}`)
      }
    }
    lines.push(body)
  }
  if (lines.length === 0) return null
  return ['按当前活动装配的本轮上下文（不是全量资料）：', ...lines].join(JOIN)
}
