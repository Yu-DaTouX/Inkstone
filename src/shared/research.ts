import {
  latestVersionOf,
  refReadable,
  sourceById,
  versionByRef,
  type LibraryDocument,
  type SourceReference
} from './library'

export const SOURCE_REF_STATUSES = ['current', 'outdated', 'removed', 'missing', 'unreadable'] as const
export type SourceRefStatus = (typeof SOURCE_REF_STATUSES)[number]

export interface SourceStatus {
  ref: { sourceId: string; version: number; locator?: { start: number; end: number } }
  status: SourceRefStatus
  title?: string
  latestVersion?: number
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

export interface ResearchExcerpt {
  sourceId: string
  version: number
  title: string
  text: string
  truncated: boolean
  locator?: { start: number; end: number }
  status: SourceRefStatus
  latestVersion?: number
}

export function excerptText(
  text: string,
  locator: { start: number; end: number } | undefined,
  maxChars: number
): { text: string; truncated: boolean } {
  const body = String(text ?? '')
  if (!body) return { text: '', truncated: false }
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

export function excerptReadable(status: SourceRefStatus | undefined): boolean {
  return status === undefined || status === 'current' || status === 'outdated'
}
