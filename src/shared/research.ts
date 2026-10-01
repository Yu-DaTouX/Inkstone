/**
 * 资料引用的读取与状态。
 *
 * 宿主只负责两件与数据有关的事：
 * 1. **旧引用按版本保留**：资料更新后，引用仍然指着当时那一版；
 *    这里只**提示变化**（「来源已更新到 v3，这条引用还是 v1」），不改写引用。
 * 2. **按版本读片段**：读每一份引用当时那一版的正文片段，读不到的如实标出。
 *
 * 怎么对照多份资料、怎么标立场与区分原文和补充，是写给模型的做法，
 * 放在随包的 `research` 技能里，不在宿主里另立一套规则。
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

/* ------------------------------------------------------------------ *
 * 按版本读片段
 * ------------------------------------------------------------------ */

export interface ResearchExcerpt {
  sourceId: string
  version: number
  /** 展示标题（取自资料库）。 */
  title: string
  /** 这一版在 locator 区间（或开头）的正文。 */
  text: string
  /** 片段比原区间短时为 true。 */
  truncated: boolean
  locator?: { start: number; end: number }
  /** 引用状态（旧版本 / 已更新）。 */
  status: SourceRefStatus
  /** 该来源现在的最新版本（引用已旧时给出）。 */
  latestVersion?: number
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

/** 这条引用还能不能当正文读（读不到的不能当作有效证据）。 */
export function excerptReadable(status: SourceRefStatus | undefined): boolean {
  return status === undefined || status === 'current' || status === 'outdated'
}
