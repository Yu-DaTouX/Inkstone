/**
 * 跨资料研究（实施-25 P13）—— 契约与对照规则。
 *
 * ── 这一片要守住的两条 ──
 * 1. **不强行合一**：几份资料说法不一致时，界面上是**并排的两组**，
 *    不是一句「综合来看」。合并是研究者的判断，不是宿主的默认动作 ——
 *    模型可以给结论，但它必须标清那是自己补的还是资料原文。
 * 2. **旧引用按版本保留**：资料更新后，成果里那条引用仍然指着**当时那一版**；
 *    我们能做的是**提示变化**（「来源已更新到 v3，这条引用还是 v1」），
 *    不是把它悄悄改成新版（那是 P03 的不变量）。
 *
 * `provenance`（引用原文 / 模型补充）是给读者看的，不让模型自己口述 ——
 * 口述的「据资料显示」和真正带版本的引用在界面上必须长得不一样。
 */

import {
  latestVersionOf,
  refReadable,
  sourceById,
  versionByRef,
  type LibraryDocument,
  type SourceReference
} from './library'

/* ------------------------------------------------------------------ *
 * 来源的两种身份
 * ------------------------------------------------------------------ */

export const PROVENANCES = ['material', 'model'] as const
export type SourceProvenance = (typeof PROVENANCES)[number]

export const PROVENANCE_LABELS: Record<SourceProvenance, string> = {
  material: '引用原文',
  model: '模型补充'
}

export const PROVENANCE_NOTES: Record<SourceProvenance, string> = {
  material: '来自资料，带版本与位置；资料改版不会改写这条',
  model: '模型补的，不是资料原文'
}

export function provenanceLabel(value: unknown): SourceProvenance {
  return value === 'model' ? 'model' : 'material'
}

/* ------------------------------------------------------------------ *
 * 引用现在怎么样了（T13-4）
 * ------------------------------------------------------------------ */

export const SOURCE_REF_STATUSES = ['current', 'outdated', 'removed', 'missing', 'unreadable'] as const
export type SourceRefStatus = (typeof SOURCE_REF_STATUSES)[number]

export interface SourceStatus {
  ref: { sourceId: string; version: number; locator?: { start: number; end: number } }
  status: SourceRefStatus
  title?: string
  /** 该来源现在的最新版本（「来源已更新」时用）。 */
  latestVersion?: number
  /** 给用户看的一句话。 */
  note: string
}

export function sourceStatusNote(status: SourceRefStatus, ref: SourceReference, latest?: number): string {
  switch (status) {
    case 'current':
      return `这一版还能读（v${ref.version}）`
    case 'outdated':
      return `来源已更新到 v${latest ?? '?'}，这条引用仍指着 v${ref.version}`
    case 'removed':
      return '来源已从资料库移除，旧版本仍能打开'
    case 'missing':
      return '找不到这一版（可能被删过版本或换了资料库）'
    case 'unreadable':
      return '这一版没有可读正文（例如二进制文件或未解析成功）'
  }
}

/** 一条引用现在的状态。判定顺序即优先级：先看能不能找到，再看是否已旧。 */
export function sourceStatus(
  doc: LibraryDocument,
  ref: SourceReference,
  locator?: { start: number; end: number }
): SourceStatus {
  const base = {
    ref: { sourceId: ref.sourceId, version: ref.version, ...(locator ? { locator } : {}) }
  }
  const version = versionByRef(doc, ref)
  const source = sourceById(doc, ref.sourceId)
  if (!version || !source) {
    return { ...base, status: 'missing', note: sourceStatusNote('missing', ref) }
  }
  const title = source.title
  if (source.removedAt !== undefined) {
    return { ...base, title, status: 'removed', note: sourceStatusNote('removed', ref) }
  }
  const latest = latestVersionOf(doc, ref.sourceId)
  if (latest && latest.version > ref.version) {
    return {
      ...base,
      title,
      status: 'outdated',
      latestVersion: latest.version,
      note: sourceStatusNote('outdated', ref, latest.version)
    }
  }
  if (!refReadable(doc, ref)) {
    return { ...base, title, status: 'unreadable', note: sourceStatusNote('unreadable', ref) }
  }
  return { ...base, title, status: 'current', note: sourceStatusNote('current', ref) }
}

/** 一份成果引用的全部资料现在怎么样了（成果页那一排提示）。 */
export function artifactSourceStatuses(
  doc: LibraryDocument,
  sources: readonly { sourceId: string; version: number; locator?: { start: number; end: number } }[]
): SourceStatus[] {
  return sources.map((item) => sourceStatus(doc, { sourceId: item.sourceId, version: item.version }, item.locator))
}

/** 「有东西变了」的简短结论（没有变化就返回 null，界面上不制造噪声）。 */
export function sourceChangeSummary(statuses: readonly SourceStatus[]): string | null {
  const outdated = statuses.filter((s) => s.status === 'outdated').length
  const gone = statuses.filter((s) => s.status === 'removed' || s.status === 'missing').length
  if (outdated === 0 && gone === 0) return null
  const parts: string[] = []
  if (outdated > 0) parts.push(`${outdated} 条来源已有新版本`)
  if (gone > 0) parts.push(`${gone} 条来源已找不到`)
  return `${parts.join('，')}；引用的旧版本仍然保留`
}

/* ------------------------------------------------------------------ *
 * 多来源对照（T13-2 / T13-3）
 * ------------------------------------------------------------------ */

export interface ResearchExcerpt {
  sourceId: string
  version: number
  /** 展示标题（取自资料库，不复制进题面）。 */
  title: string
  provenance: SourceProvenance
  /** 这份资料对当前问题说了什么。 */
  text: string
  /**
   * 立场标签（「支持」「反对」「补充」这类）。
   *
   * **由调用方给，宿主不猜** —— 判断两份材料是不是在讲同一件事，
   * 属于研究者的判断；宿主只负责「不把它们合并」。
   */
  stance?: string
  locator?: { start: number; end: number }
  /** 引用状态（旧版本 / 已更新）。 */
  status?: SourceRefStatus
}

export interface ComparisonGroup {
  label: string
  excerpts: ResearchExcerpt[]
}

export interface ComparisonConflict {
  /** 冲突的说明（只说「这两组不一致」，不下结论）。 */
  label: string
  left: ResearchExcerpt
  right: ResearchExcerpt
}

export interface Comparison {
  question: string
  groups: ComparisonGroup[]
  conflicts: ComparisonConflict[]
  /** 来源构成：多少条来自原文、多少条是模型补充。 */
  provenance: { material: number; model: number }
  /** 规则说明（写出来给读者看，不藏在实现里）。 */
  note: string
}

export const COMPARISON_NOTE = '说法不一致的地方保留为并列的两组，没有合并成一个结论。'
export const UNLABELED_STANCE = '未标注立场'

/**
 * 把多份摘录按立场分组，并列出不一致之处。
 *
 * 刻意**不做**的事：不给「哪个对」的判断、不合并成一段总结、不排序谁更可信。
 * 冲突只发生在**两个显式且不同的立场标签**之间 —— 未标注的不算冲突
 * （我们不知道它们是不是在说同一件事）。
 */
export function buildComparison(input: { question: string; excerpts: readonly ResearchExcerpt[] }): Comparison {
  const groups: ComparisonGroup[] = []
  const index = new Map<string, ResearchExcerpt[]>()
  for (const excerpt of input.excerpts) {
    const label = excerpt.stance?.trim() || UNLABELED_STANCE
    const bucket = index.get(label)
    if (bucket) bucket.push(excerpt)
    else index.set(label, [excerpt])
  }
  for (const [label, excerpts] of index) groups.push({ label, excerpts })

  const labeled = groups.filter((g) => g.label !== UNLABELED_STANCE)
  const conflicts: ComparisonConflict[] = []
  for (let i = 0; i < labeled.length; i += 1) {
    for (let j = i + 1; j < labeled.length; j += 1) {
      const left = labeled[i]
      const right = labeled[j]
      conflicts.push({
        label: `「${left.label}」与「${right.label}」的说法不一致`,
        left: left.excerpts[0],
        right: right.excerpts[0]
      })
    }
  }

  const provenance = {
    material: input.excerpts.filter((e) => e.provenance === 'material').length,
    model: input.excerpts.filter((e) => e.provenance === 'model').length
  }
  return { question: input.question, groups, conflicts, provenance, note: COMPARISON_NOTE }
}

/** 供模型 / 导出读的纯文本（不合并结论，只把并列关系讲清）。 */
export function comparisonText(comparison: Comparison): string {
  const lines: string[] = [`问题：${comparison.question}`, '']
  for (const group of comparison.groups) {
    lines.push(`【${group.label}】`)
    for (const excerpt of group.excerpts) {
      const provenance = PROVENANCE_LABELS[excerpt.provenance]
      const where = excerpt.locator ? `，第 ${excerpt.locator.start}–${excerpt.locator.end} 字` : ''
      lines.push(`- ${excerpt.title} v${excerpt.version}（${provenance}${where}）：${excerpt.text}`)
    }
    lines.push('')
  }
  if (comparison.conflicts.length > 0) {
    lines.push('不一致之处：')
    for (const conflict of comparison.conflicts) lines.push(`- ${conflict.label}`)
    lines.push('')
  }
  lines.push(comparison.note)
  return lines.join('\n')
}

/**
 * 从一份正文里切出某个区间（没有 locator 就取开头一段）。
 *
 * 与教材视图同一口径：**引用位置是字符区间**，不是页码。
 */
export function excerptText(
  text: string,
  locator: { start: number; end: number } | undefined,
  maxChars: number
): { text: string; truncated: boolean } {
  const body = String(text ?? '')
  if (!body) return { text: '', truncated: false }
  /* 没有 locator：取开头一段，并在正文更长时如实标出截断。 */
  if (!locator) {
    if (body.length <= maxChars) return { text: body, truncated: false }
    return { text: body.slice(0, maxChars), truncated: true }
  }
  const start = Math.max(0, Math.min(locator.start, body.length))
  const end = Math.max(start, Math.min(locator.end, body.length))
  const slice = body.slice(start, end)
  if (slice.length <= maxChars) return { text: slice, truncated: false }
  return { text: slice.slice(0, maxChars), truncated: true }
}

/** 这条摘录是否还能当正文读（对照里不能把读不到的排进去当有效来源）。 */
export function excerptReadable(status: SourceRefStatus | undefined): boolean {
  return status === undefined || status === 'current' || status === 'outdated'
}
