import { normalizeLayoutPath } from './session-path'

export type LibraryKind = 'file' | 'web' | 'text' | 'image'

export type LibraryParseStatus = 'pending' | 'ok' | 'unsupported' | 'failed'

export interface LibraryParse {
  status: LibraryParseStatus
  textPath?: string
  chars?: number
  pages?: number
  note: string
  at: number
}

export interface LibrarySource {
  id: string
  spaceId?: string
  kind: LibraryKind
  title: string
  createdAt: number
  updatedAt: number
  removedAt?: number
  unavailableAt?: number
}

export interface LibraryVersion {
  sourceId: string
  version: number
  identity: string
  ref: string
  title: string
  size?: number
  fingerprint: string
  addedAt: number
  available: boolean
  checkedAt?: number
  parse: LibraryParse
}

export interface SourceReference {
  sourceId: string
  version: number
}

export type LibraryOwnerKind = 'session' | 'course' | 'artifact'

export interface LibraryOwner {
  kind: LibraryOwnerKind
  id: string
}

export interface LibraryRefRecord {
  owner: LibraryOwner
  ref: SourceReference
  at: number
}

export interface LegacySourceMap {
  legacyId: string
  sessionId: string
  sourceId: string
  version: number
  at: number
}

export interface LibraryDocument {
  version: 1
  sources: LibrarySource[]
  versions: LibraryVersion[]
  refs: LibraryRefRecord[]
  legacy: LegacySourceMap[]
}

export const EMPTY_LIBRARY: LibraryDocument = { version: 1, sources: [], versions: [], refs: [], legacy: [] }

export const MAX_LIBRARY_SOURCES = 2000
export const MAX_TITLE = 200
export const MAX_NOTE = 500

export function normalizeWebUrl(raw: string): string {
  const trimmed = raw.trim()
  try {
    const url = new URL(trimmed)
    url.hash = ''
    const host = url.host.toLowerCase()
    let path = url.pathname.replace(/\/+$/, '')
    if (!path) path = '/'
    const query = url.search
    return `${url.protocol}//${host}${path}${query}`
  } catch {
    return trimmed.split('#')[0].replace(/\/+$/, '')
  }
}

export function contentIdentity(kind: LibraryKind, value: string): string {
  if (kind === 'web') return `web:${normalizeWebUrl(value)}`
  if (kind === 'file') return `file:${normalizeLayoutPath(value)}`
  return `${kind}:${value.trim()}`
}

export function sameRef(a: SourceReference | null | undefined, b: SourceReference | null | undefined): boolean {
  if (!a || !b) return false
  return a.sourceId === b.sourceId && a.version === b.version
}

export function refKey(ref: SourceReference): string {
  return `${ref.sourceId}@${ref.version}`
}

export function sameOwner(a: LibraryOwner, b: LibraryOwner): boolean {
  return a.kind === b.kind && a.id === b.id
}

export interface LibraryImportInput {
  kind: LibraryKind
  identity: string
  fingerprint: string
  title: string
  ref: string
  size?: number
  spaceId?: string
  at?: number
}

export type LibraryImportDecision =
  | { kind: 'unchanged'; sourceId: string; version: number }
  | { kind: 'new-version'; sourceId: string; version: number }
  | { kind: 'new-source'; version: number }
  | { kind: 'rejected'; reason: string }

export function decideImport(doc: LibraryDocument, input: LibraryImportInput): LibraryImportDecision {
  const check = validateImport(input)
  if (!check.ok) return { kind: 'rejected', reason: check.reason }

  const owned = doc.versions.filter((v) => v.identity === input.identity)
  if (owned.length === 0) {
    if (doc.sources.length >= MAX_LIBRARY_SOURCES) {
      return { kind: 'rejected', reason: `资料库最多 ${MAX_LIBRARY_SOURCES} 份资料` }
    }
    return { kind: 'new-source', version: 1 }
  }
  const latest = owned.reduce((a, b) => (b.version > a.version ? b : a))
  if (latest.fingerprint === input.fingerprint) {
    return { kind: 'unchanged', sourceId: latest.sourceId, version: latest.version }
  }
  return { kind: 'new-version', sourceId: latest.sourceId, version: latest.version + 1 }
}

export function validateImport(input: LibraryImportInput): { ok: true } | { ok: false; reason: string } {
  if (!input || typeof input !== 'object') return { ok: false, reason: '导入参数不是对象' }
  if (!['file', 'web', 'text', 'image'].includes(input.kind)) return { ok: false, reason: `未知的资料类型：${String(input.kind)}` }
  if (typeof input.identity !== 'string' || !input.identity.trim()) return { ok: false, reason: '缺少内容身份' }
  if (typeof input.fingerprint !== 'string' || !input.fingerprint.trim()) {
    return { ok: false, reason: '缺少内容指纹（无法判断内容是否变化）' }
  }
  if (typeof input.ref !== 'string' || !input.ref.trim()) return { ok: false, reason: '缺少打开引用' }
  if (typeof input.title !== 'string' || !input.title.trim()) return { ok: false, reason: '标题不能为空' }
  if (input.title.length > MAX_TITLE) return { ok: false, reason: `标题最多 ${MAX_TITLE} 个字符` }
  if (/[\u0000-\u001f\u007f]/.test(input.title)) return { ok: false, reason: '标题含控制字符' }
  return { ok: true }
}

export function sourceById(doc: LibraryDocument, sourceId: string): LibrarySource | undefined {
  return doc.sources.find((s) => s.id === sourceId)
}

export function versionsOf(doc: LibraryDocument, sourceId: string): LibraryVersion[] {
  return doc.versions.filter((v) => v.sourceId === sourceId).sort((a, b) => a.version - b.version)
}

export function latestVersionOf(doc: LibraryDocument, sourceId: string): LibraryVersion | undefined {
  const list = versionsOf(doc, sourceId)
  return list.length ? list[list.length - 1] : undefined
}

export function versionByRef(doc: LibraryDocument, ref: SourceReference): LibraryVersion | undefined {
  return doc.versions.find((v) => v.sourceId === ref.sourceId && v.version === ref.version)
}

export function isActiveSource(source: LibrarySource | undefined): boolean {
  return !!source && source.removedAt === undefined
}

export function activeSources(doc: LibraryDocument, spaceId?: string | null): LibrarySource[] {
  return doc.sources
    .filter((s) => isActiveSource(s))
    .filter((s) => (spaceId === undefined ? true : (s.spaceId ?? null) === spaceId))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function refsForOwner(doc: LibraryDocument, owner: LibraryOwner): SourceReference[] {
  return doc.refs.filter((r) => sameOwner(r.owner, owner)).map((r) => r.ref)
}

export function ownersForSource(doc: LibraryDocument, sourceId: string): LibraryRefRecord[] {
  return doc.refs.filter((r) => r.ref.sourceId === sourceId)
}

export function legacyMappingOf(
  doc: LibraryDocument,
  legacyId: string,
  sessionId: string
): LegacySourceMap | undefined {
  return doc.legacy.find((l) => l.legacyId === legacyId && l.sessionId === sessionId)
}

export type RefOutcome = 'ok' | 'removed' | 'unavailable' | 'unsupported' | 'pending' | 'failed' | 'missing'

export function refOutcome(doc: LibraryDocument, ref: SourceReference): RefOutcome {
  const version = versionByRef(doc, ref)
  if (!version) return 'missing'
  const source = sourceById(doc, ref.sourceId)
  if (!source) return 'missing'
  if (!version.available) return 'unavailable'
  if (source.removedAt !== undefined) return 'removed'
  if (version.parse.status === 'pending') return 'pending'
  if (version.parse.status === 'unsupported') return 'unsupported'
  if (version.parse.status === 'failed') return 'failed'
  return 'ok'
}

export function refReadable(doc: LibraryDocument, ref: SourceReference): boolean {
  const version = versionByRef(doc, ref)
  return !!version && version.available && version.parse.status === 'ok' && !!version.parse.textPath
}
