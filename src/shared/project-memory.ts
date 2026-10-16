import type { ProjectRecord } from './ipc'

export const PROJECT_KNOWLEDGE_SCHEMA_VERSION = 1

export const PROJECT_KNOWLEDGE_LIMITS = {
  maxTextLength: 4000,
  maxTags: 16,
  maxTagLength: 64,
  maxEvidence: 16,
  maxEvidenceExcerpt: 500,
  maxValidForPaths: 32,
  maxRefLength: 512,
  maxSupersedes: 16,
  maxEntries: 500
} as const

export const KNOWLEDGE_KINDS = ['decision', 'constraint', 'fact', 'procedure'] as const
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number]

export const KNOWLEDGE_STATUSES = ['candidate', 'active', 'superseded', 'deleted'] as const
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number]

export const CONFIDENCE_CLASSES = ['user-confirmed', 'verified', 'inferred'] as const
export type ConfidenceClass = (typeof CONFIDENCE_CLASSES)[number]

export interface KnowledgeEvidence {
  sessionId?: string
  entryId?: string
  file?: string
  digest?: string
  excerpt?: string
}

export interface KnowledgeValidFor {
  branch?: string
  commit?: string
  paths?: string[]
}

export interface KnowledgeTombstone {
  at: string
  digest: string
  textLength: number
}

export interface ProjectKnowledge {
  schemaVersion: number
  id: string
  projectId: string
  revision: number
  kind: KnowledgeKind
  status: KnowledgeStatus
  text: string
  textDigest: string
  tags: string[]
  evidence: KnowledgeEvidence[]
  confidenceClass: ConfidenceClass
  createdAt: string
  updatedAt: string
  validFor?: KnowledgeValidFor
  supersedes?: string[]
  tombstone?: KnowledgeTombstone
}

export interface KnowledgePointer {
  id: string
  revision: number
  status: KnowledgeStatus
  kind: KnowledgeKind
  confidenceClass: ConfidenceClass
  digest: string
  createdAt: string
  updatedAt: string
  tombstoneAt?: string
}

export interface ProjectKnowledgeManifest {
  schemaVersion: number
  projectId: string
  revision: number
  updatedAt: string
  entries: KnowledgePointer[]
}

export type ProjectKnowledgeErrorCode =
  | 'bad_project_id'
  | 'unregistered_project'
  | 'bad_knowledge_id'
  | 'bad_kind'
  | 'bad_status'
  | 'empty_text'
  | 'text_too_long'
  | 'bad_tags'
  | 'bad_evidence'
  | 'bad_valid_for'
  | 'bad_supersedes'
  | 'bad_confidence'
  | 'unconfirmed_confidence'
  | 'downgrade_confirmed'
  | 'missing_evidence'
  | 'bad_expected_revision'
  | 'stale_revision'
  | 'entry_exists'
  | 'entry_not_found'
  | 'duplicate'
  | 'revives_deleted'
  | 'deleted_entry'
  | 'superseded_entry'
  | 'supersedes_deleted'
  | 'unknown_supersedes'
  | 'too_many_entries'
  | 'not_user_action'
  | 'bad_mode'
  | 'bad_schema_version'

export interface KnowledgeFailure {
  ok: false
  code: ProjectKnowledgeErrorCode
  message: string
  existingId?: string
}

function fail(code: ProjectKnowledgeErrorCode, message: string, existingId?: string): KnowledgeFailure {
  return existingId ? { ok: false, code, message, existingId } : { ok: false, code, message }
}

const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/

export function isSafeProjectId(value: unknown): value is string {
  return typeof value === 'string' && PROJECT_ID_RE.test(value) && !value.includes('..')
}

const KNOWLEDGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/

export function isSafeKnowledgeId(value: unknown): value is string {
  return typeof value === 'string' && KNOWLEDGE_ID_RE.test(value) && !value.includes('..')
}

export function isSafeRelativeRef(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const ref = value.trim()
  if (!ref || ref.length > PROJECT_KNOWLEDGE_LIMITS.maxRefLength) return false
  if (ref.includes('\u0000')) return false
  if (ref.startsWith('/') || ref.startsWith('\\')) return false
  if (/^[A-Za-z]:/.test(ref)) return false
  return !ref.split(/[\\/]+/).some((part) => part === '..')
}

export function normalizeKnowledgeText(text: string): string {
  return text.normalize('NFKC').replace(/\s+/gu, ' ').trim()
}

const FNV_OFFSET = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n
const MASK64 = 0xffffffffffffffffn

export function textDigest(text: string): string {
  const normalized = normalizeKnowledgeText(text)
  let hash = FNV_OFFSET
  for (const ch of normalized) {
    hash = ((hash ^ BigInt(ch.codePointAt(0) ?? 0)) * FNV_PRIME) & MASK64
  }
  hash = ((hash ^ BigInt([...normalized].length)) * FNV_PRIME) & MASK64
  return hash.toString(16).padStart(16, '0')
}

function charLength(text: string): number {
  return [...text].length
}

export interface ProjectIdentity {
  projectId: string
  cwd: string
}

export function resolveProjectIdentity(
  requested: unknown,
  registry: readonly ProjectRecord[]
): { ok: true; identity: ProjectIdentity; archived: boolean } | KnowledgeFailure {
  if (typeof requested !== 'string' || !requested.trim()) {
    return fail('bad_project_id', '缺少 projectId（身份由宿主按项目登记绑定，不接受 cwd 反推）')
  }
  const candidate = requested.trim()
  const hit = registry.find((project) => project.id === candidate)
  if (!hit) {
    return fail('unregistered_project', `projectId 不在项目登记里：${candidate}`)
  }
  if (!isSafeProjectId(hit.id)) {
    return fail('bad_project_id', `登记里的 projectId 形状非法，不能用作目录名：${hit.id}`)
  }
  return { ok: true, identity: { projectId: hit.id, cwd: hit.cwd }, archived: hit.archived === true }
}

export function registeredProjectIdForCwd(
  cwd: unknown,
  registry: readonly ProjectRecord[]
): string | undefined {
  if (typeof cwd !== 'string' || !cwd) return undefined
  const hit = registry.find((project) => project.cwd === cwd)
  return hit && isSafeProjectId(hit.id) ? hit.id : undefined
}

export function emptyKnowledgeManifest(projectId: string, now: string): ProjectKnowledgeManifest {
  return {
    schemaVersion: PROJECT_KNOWLEDGE_SCHEMA_VERSION,
    projectId,
    revision: 0,
    updatedAt: now,
    entries: []
  }
}

export function pointerOf(entry: ProjectKnowledge): KnowledgePointer {
  return {
    id: entry.id,
    revision: entry.revision,
    status: entry.status,
    kind: entry.kind,
    confidenceClass: entry.confidenceClass,
    digest: entry.textDigest,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    ...(entry.tombstone ? { tombstoneAt: entry.tombstone.at } : {})
  }
}

export function digestIndex(manifest: ProjectKnowledgeManifest): Map<string, KnowledgePointer> {
  const index = new Map<string, KnowledgePointer>()
  for (const pointer of manifest.entries) {
    if (!index.has(pointer.digest)) index.set(pointer.digest, pointer)
  }
  return index
}

export function findKnowledgePointer(
  manifest: ProjectKnowledgeManifest,
  id: string
): KnowledgePointer | undefined {
  return manifest.entries.find((pointer) => pointer.id === id)
}

export function inspectKnowledgeManifest(
  value: unknown
): { status: 'ok'; manifest: ProjectKnowledgeManifest } | { status: 'invalid'; reason: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { status: 'invalid', reason: '不是对象' }
  }
  const raw = value as Partial<ProjectKnowledgeManifest> & Record<string, unknown>
  if (raw.schemaVersion !== PROJECT_KNOWLEDGE_SCHEMA_VERSION) {
    return { status: 'invalid', reason: `schemaVersion 不认识：${String(raw.schemaVersion)}` }
  }
  if (!isSafeProjectId(raw.projectId)) return { status: 'invalid', reason: 'projectId 非法' }
  if (!Number.isInteger(raw.revision) || (raw.revision as number) < 0) {
    return { status: 'invalid', reason: 'revision 不是非负整数' }
  }
  if (typeof raw.updatedAt !== 'string') return { status: 'invalid', reason: 'updatedAt 不是字符串' }
  if (!Array.isArray(raw.entries)) return { status: 'invalid', reason: 'entries 不是数组' }

  const entries: KnowledgePointer[] = []
  const seen = new Set<string>()
  for (const item of raw.entries) {
    const pointer = inspectPointer(item)
    if (!pointer) return { status: 'invalid', reason: 'entries 里有认不出的指针' }
    if (seen.has(pointer.id)) return { status: 'invalid', reason: `entries 里 id 重复：${pointer.id}` }
    seen.add(pointer.id)
    entries.push(pointer)
  }
  return {
    status: 'ok',
    manifest: {
      schemaVersion: PROJECT_KNOWLEDGE_SCHEMA_VERSION,
      projectId: raw.projectId as string,
      revision: raw.revision as number,
      updatedAt: raw.updatedAt,
      entries
    }
  }
}

function inspectPointer(value: unknown): KnowledgePointer | undefined {
  if (!value || typeof value !== 'object') return undefined
  const p = value as Partial<KnowledgePointer> & Record<string, unknown>
  if (!isSafeKnowledgeId(p.id)) return undefined
  if (!Number.isInteger(p.revision) || (p.revision as number) < 1) return undefined
  if (!KNOWLEDGE_STATUSES.includes(p.status as KnowledgeStatus)) return undefined
  if (!KNOWLEDGE_KINDS.includes(p.kind as KnowledgeKind)) return undefined
  if (!CONFIDENCE_CLASSES.includes(p.confidenceClass as ConfidenceClass)) return undefined
  if (typeof p.digest !== 'string' || !p.digest) return undefined
  if (typeof p.createdAt !== 'string' || typeof p.updatedAt !== 'string') return undefined
  return {
    id: p.id as string,
    revision: p.revision as number,
    status: p.status as KnowledgeStatus,
    kind: p.kind as KnowledgeKind,
    confidenceClass: p.confidenceClass as ConfidenceClass,
    digest: p.digest,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    ...(typeof p.tombstoneAt === 'string' ? { tombstoneAt: p.tombstoneAt } : {})
  }
}

export interface KnowledgeDraft {
  kind: unknown
  text: unknown
  tags?: unknown
  evidence?: unknown
  confidenceClass?: unknown
  validFor?: unknown
  supersedes?: unknown
}

export interface ValidatedKnowledgeDraft {
  kind: KnowledgeKind
  text: string
  textDigest: string
  tags: string[]
  evidence: KnowledgeEvidence[]
  confidenceClass: ConfidenceClass
  validFor?: KnowledgeValidFor
  supersedes: string[]
}

export function validateKnowledgeDraft(
  draft: KnowledgeDraft
): { ok: true; value: ValidatedKnowledgeDraft } | KnowledgeFailure {
  if (!KNOWLEDGE_KINDS.includes(draft.kind as KnowledgeKind)) {
    return fail('bad_kind', `kind 必须是 ${KNOWLEDGE_KINDS.join(' / ')}（收到 ${JSON.stringify(draft.kind)}）`)
  }
  if (typeof draft.text !== 'string') {
    return fail('empty_text', 'text 必须是字符串')
  }
  if (draft.text.trim().length === 0) return fail('empty_text', 'text 是空的')
  if (charLength(draft.text) > PROJECT_KNOWLEDGE_LIMITS.maxTextLength) {
    return fail(
      'text_too_long',
      `text 超过 ${PROJECT_KNOWLEDGE_LIMITS.maxTextLength} 字符（实际 ${charLength(draft.text)}）`
    )
  }

  const tags = parseTags(draft.tags)
  if (!tags.ok) return tags
  const evidence = parseEvidence(draft.evidence)
  if (!evidence.ok) return evidence
  const validFor = parseValidFor(draft.validFor)
  if (!validFor.ok) return validFor
  const supersedes = parseSupersedes(draft.supersedes)
  if (!supersedes.ok) return supersedes

  const confidence = draft.confidenceClass ?? 'inferred'
  if (!CONFIDENCE_CLASSES.includes(confidence as ConfidenceClass)) {
    return fail('bad_confidence', `confidenceClass 必须是 ${CONFIDENCE_CLASSES.join(' / ')}`)
  }

  return {
    ok: true,
    value: {
      kind: draft.kind as KnowledgeKind,
      text: draft.text,
      textDigest: textDigest(draft.text),
      tags: tags.value,
      evidence: evidence.value,
      confidenceClass: confidence as ConfidenceClass,
      ...(validFor.value ? { validFor: validFor.value } : {}),
      supersedes: supersedes.value
    }
  }
}

function parseTags(raw: unknown): { ok: true; value: string[] } | KnowledgeFailure {
  if (raw === undefined || raw === null) return { ok: true, value: [] }
  if (!Array.isArray(raw)) return fail('bad_tags', 'tags 必须是字符串数组')
  if (raw.length > PROJECT_KNOWLEDGE_LIMITS.maxTags) {
    return fail('bad_tags', `tags 最多 ${PROJECT_KNOWLEDGE_LIMITS.maxTags} 个`)
  }
  const out: string[] = []
  for (const tag of raw) {
    if (typeof tag !== 'string') return fail('bad_tags', 'tags 里有非字符串')
    const value = tag.trim()
    if (!value) return fail('bad_tags', 'tags 里有空字符串')
    if (charLength(value) > PROJECT_KNOWLEDGE_LIMITS.maxTagLength) {
      return fail('bad_tags', `标签「${value}」超过 ${PROJECT_KNOWLEDGE_LIMITS.maxTagLength} 字符`)
    }
    if (!out.includes(value)) out.push(value)
  }
  return { ok: true, value: out }
}

function parseEvidence(raw: unknown): { ok: true; value: KnowledgeEvidence[] } | KnowledgeFailure {
  if (raw === undefined || raw === null) return { ok: true, value: [] }
  if (!Array.isArray(raw)) return fail('bad_evidence', 'evidence 必须是数组')
  if (raw.length > PROJECT_KNOWLEDGE_LIMITS.maxEvidence) {
    return fail('bad_evidence', `evidence 最多 ${PROJECT_KNOWLEDGE_LIMITS.maxEvidence} 条`)
  }
  const out: KnowledgeEvidence[] = []
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i]
    const at = i + 1
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return fail('bad_evidence', `第 ${at} 条证据不是对象`)
    }
    const e = item as Record<string, unknown>
    const evidence: KnowledgeEvidence = {}
    for (const key of ['sessionId', 'entryId', 'digest'] as const) {
      const v = e[key]
      if (v === undefined || v === null) continue
      if (typeof v !== 'string' || !v.trim()) return fail('bad_evidence', `第 ${at} 条证据的 ${key} 不是非空字符串`)
      if (charLength(v) > PROJECT_KNOWLEDGE_LIMITS.maxRefLength) {
        return fail('bad_evidence', `第 ${at} 条证据的 ${key} 太长`)
      }
      evidence[key] = v
    }
    if (e.file !== undefined && e.file !== null) {
      if (!isSafeRelativeRef(e.file)) {
        return fail('bad_evidence', `第 ${at} 条证据的 file 必须是项目内的相对路径（不能绝对路径 / ..）`)
      }
      evidence.file = (e.file as string).trim()
    }
    if (e.excerpt !== undefined && e.excerpt !== null) {
      if (typeof e.excerpt !== 'string') return fail('bad_evidence', `第 ${at} 条证据的 excerpt 不是字符串`)
      if (charLength(e.excerpt) > PROJECT_KNOWLEDGE_LIMITS.maxEvidenceExcerpt) {
        return fail('bad_evidence', `第 ${at} 条证据的 excerpt 超过 ${PROJECT_KNOWLEDGE_LIMITS.maxEvidenceExcerpt} 字符`)
      }
      if (e.excerpt.trim()) evidence.excerpt = e.excerpt
    }
    if (Object.keys(evidence).length === 0) {
      return fail('bad_evidence', `第 ${at} 条证据没有任何字段（来源必须可追溯）`)
    }
    out.push(evidence)
  }
  return { ok: true, value: out }
}

function parseValidFor(raw: unknown): { ok: true; value?: KnowledgeValidFor } | KnowledgeFailure {
  if (raw === undefined || raw === null) return { ok: true }
  if (typeof raw !== 'object' || Array.isArray(raw)) return fail('bad_valid_for', 'validFor 必须是对象')
  const v = raw as Record<string, unknown>
  const out: KnowledgeValidFor = {}
  for (const key of ['branch', 'commit'] as const) {
    const value = v[key]
    if (value === undefined || value === null) continue
    if (typeof value !== 'string' || !value.trim()) return fail('bad_valid_for', `validFor.${key} 不是非空字符串`)
    if (charLength(value) > PROJECT_KNOWLEDGE_LIMITS.maxRefLength) {
      return fail('bad_valid_for', `validFor.${key} 太长`)
    }
    out[key] = value.trim()
  }
  if (v.paths !== undefined && v.paths !== null) {
    if (!Array.isArray(v.paths)) return fail('bad_valid_for', 'validFor.paths 必须是数组')
    if (v.paths.length > PROJECT_KNOWLEDGE_LIMITS.maxValidForPaths) {
      return fail('bad_valid_for', `validFor.paths 最多 ${PROJECT_KNOWLEDGE_LIMITS.maxValidForPaths} 条`)
    }
    const paths: string[] = []
    for (const p of v.paths) {
      if (!isSafeRelativeRef(p)) return fail('bad_valid_for', 'validFor.paths 里有非相对路径')
      if (!paths.includes(p.trim())) paths.push(p.trim())
    }
    if (paths.length > 0) out.paths = paths
  }
  return Object.keys(out).length > 0 ? { ok: true, value: out } : { ok: true }
}

function parseSupersedes(raw: unknown): { ok: true; value: string[] } | KnowledgeFailure {
  if (raw === undefined || raw === null) return { ok: true, value: [] }
  if (!Array.isArray(raw)) return fail('bad_supersedes', 'supersedes 必须是条目 id 数组')
  if (raw.length > PROJECT_KNOWLEDGE_LIMITS.maxSupersedes) {
    return fail('bad_supersedes', `supersedes 最多 ${PROJECT_KNOWLEDGE_LIMITS.maxSupersedes} 条`)
  }
  const out: string[] = []
  for (const id of raw) {
    if (!isSafeKnowledgeId(id)) return fail('bad_supersedes', `supersedes 里有非法条目 id：${JSON.stringify(id)}`)
    if (!out.includes(id)) out.push(id)
  }
  return { ok: true, value: out }
}

export function readKnowledgeFile(value: unknown): ProjectKnowledge | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Partial<ProjectKnowledge> & Record<string, unknown>
  if (raw.schemaVersion !== PROJECT_KNOWLEDGE_SCHEMA_VERSION) return undefined
  if (!isSafeKnowledgeId(raw.id)) return undefined
  if (!isSafeProjectId(raw.projectId)) return undefined
  if (!Number.isInteger(raw.revision) || (raw.revision as number) < 1) return undefined
  if (!KNOWLEDGE_KINDS.includes(raw.kind as KnowledgeKind)) return undefined
  if (!KNOWLEDGE_STATUSES.includes(raw.status as KnowledgeStatus)) return undefined
  if (!CONFIDENCE_CLASSES.includes(raw.confidenceClass as ConfidenceClass)) return undefined
  if (typeof raw.text !== 'string') return undefined
  if (typeof raw.textDigest !== 'string' || !raw.textDigest) return undefined
  if (typeof raw.createdAt !== 'string' || typeof raw.updatedAt !== 'string') return undefined

  const tombstone = inspectTombstone(raw.tombstone)
  if (raw.text.trim().length === 0 && !(raw.status === 'deleted' && tombstone)) return undefined

  const tags = Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === 'string') : []
  const evidence = Array.isArray(raw.evidence)
    ? raw.evidence.filter((e): e is KnowledgeEvidence => !!e && typeof e === 'object' && !Array.isArray(e))
    : []
  const scope = parseValidFor(raw.validFor)
  if (!scope.ok) return undefined
  const validFor = scope.value
  const supersedes = Array.isArray(raw.supersedes)
    ? raw.supersedes.filter((s): s is string => isSafeKnowledgeId(s))
    : []

  return {
    schemaVersion: PROJECT_KNOWLEDGE_SCHEMA_VERSION,
    id: raw.id,
    projectId: raw.projectId,
    revision: raw.revision as number,
    kind: raw.kind as KnowledgeKind,
    status: raw.status as KnowledgeStatus,
    text: raw.text,
    textDigest: raw.textDigest,
    tags,
    evidence,
    confidenceClass: raw.confidenceClass as ConfidenceClass,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    ...(validFor && Object.keys(validFor).length > 0 ? { validFor } : {}),
    ...(supersedes.length > 0 ? { supersedes } : {}),
    ...(tombstone ? { tombstone } : {})
  }
}

function inspectTombstone(value: unknown): KnowledgeTombstone | undefined {
  if (!value || typeof value !== 'object') return undefined
  const t = value as Partial<KnowledgeTombstone> & Record<string, unknown>
  if (typeof t.at !== 'string' || typeof t.digest !== 'string' || !t.digest) return undefined
  if (!Number.isInteger(t.textLength) || (t.textLength as number) < 0) return undefined
  return { at: t.at, digest: t.digest, textLength: t.textLength as number }
}

export interface KnowledgeHostCheck {
  userConfirmed?: { sessionId?: string; quote: string } | null
  evidenceVerified?: boolean
}

export interface KnowledgeCommitRequest {
  id?: unknown
  kind: unknown
  text: unknown
  tags?: unknown
  evidence?: unknown
  confidenceClass?: unknown
  validFor?: unknown
  supersedes?: unknown
  expectedSupersedesRevisions?: Record<string, number>
  expectedRevision: unknown
}

export interface KnowledgeCommitContext {
  newId: string
  now: string
  current: ProjectKnowledge | null
  digests: ReadonlyMap<string, KnowledgePointer>
  supersedesTargets: ReadonlyMap<string, ProjectKnowledge>
  hostCheck?: KnowledgeHostCheck
}

export type KnowledgeCommitResult =
  | {
      ok: true
      manifest: ProjectKnowledgeManifest
      entry: ProjectKnowledge
      superseded: ProjectKnowledge[]
    }
  | KnowledgeFailure

function parseExpectedRevision(raw: unknown): { ok: true; value: number } | KnowledgeFailure {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    return fail('bad_expected_revision', `expectedRevision 必须是从 0 开始的整数（收到 ${JSON.stringify(raw)}）`)
  }
  return { ok: true, value: raw }
}

export function applyKnowledgeCommit(
  manifest: ProjectKnowledgeManifest,
  request: KnowledgeCommitRequest,
  ctx: KnowledgeCommitContext
): KnowledgeCommitResult {
  const expected = parseExpectedRevision(request.expectedRevision)
  if (!expected.ok) return expected

  let id: string
  if (request.id === undefined || request.id === null || request.id === '') {
    if (expected.value !== 0) {
      return fail('bad_knowledge_id', '更新必须给 id')
    }
    id = ctx.newId
  } else {
    if (!isSafeKnowledgeId(request.id)) return fail('bad_knowledge_id', `条目 id 非法：${JSON.stringify(request.id)}`)
    id = request.id
  }
  if (!isSafeKnowledgeId(id)) return fail('bad_knowledge_id', `宿主生成的 id 非法：${id}`)

  const creating = expected.value === 0
  if (creating && ctx.current) {
    return fail('entry_exists', `条目已存在（要更新请带上 expectedRevision）：${id}`, id)
  }
  if (!creating) {
    if (!ctx.current) return fail('entry_not_found', `没有这条知识：${id}`, id)
    if (ctx.current.revision !== expected.value) {
      return fail(
        'stale_revision',
        `revision 冲突：磁盘上是 ${ctx.current.revision}，这次提交基于 ${expected.value}（读回最新版本再合并）`,
        id
      )
    }
    if (ctx.current.status === 'deleted') {
      return fail('deleted_entry', `条目已删除，不能直接更新：${id}`, id)
    }
    if (ctx.current.status === 'superseded') {
      return fail('superseded_entry', `条目已被替代，要改请显式新建并关联：${id}`, id)
    }
  }

  const draft = validateKnowledgeDraft(request)
  if (!draft.ok) return draft
  const value = draft.value
  const current = ctx.current

  const confirmed = !!ctx.hostCheck?.userConfirmed?.quote?.trim()
  if (value.confidenceClass === 'user-confirmed' && !confirmed) {
    return fail(
      'unconfirmed_confidence',
      'confidenceClass: user-confirmed 只能由宿主按用户在会话里的明确要求写入（不能自报）'
    )
  }
  if (value.confidenceClass === 'verified' && value.evidence.length === 0) {
    return fail('missing_evidence', 'confidenceClass: verified 必须带至少一条来源证据')
  }
  if (current && current.confidenceClass === 'user-confirmed' && value.confidenceClass !== 'user-confirmed' && !confirmed) {
    return fail('downgrade_confirmed', '不能在没有新的用户确认时把已确认条目降级')
  }

  const superseded: ProjectKnowledge[] = []
  for (const targetId of value.supersedes) {
    if (targetId === id) return fail('bad_supersedes', '不能替代自己')
    const target = ctx.supersedesTargets.get(targetId)
    if (!target) return fail('unknown_supersedes', `supersedes 指向不存在的条目：${targetId}`, targetId)
    const expectedTargetRevision = request.expectedSupersedesRevisions?.[targetId]
    if (expectedTargetRevision !== undefined && expectedTargetRevision !== target.revision) return fail('stale_revision', `被替代条目已更新，请刷新：${targetId}`, targetId)
    if (target.status === 'deleted') {
      return fail('supersedes_deleted', `supersedes 指向已删除的条目：${targetId}`, targetId)
    }
    if (target.status === 'superseded') continue
    superseded.push({ ...target, status: 'superseded', revision: target.revision + 1, updatedAt: ctx.now })
  }

  if (creating || !current || value.textDigest !== current.textDigest) {
    const hit = ctx.digests.get(value.textDigest)
    if (hit && hit.id !== id) {
      if (hit.status === 'deleted') {
        return fail(
          'revives_deleted',
          `这段文字对应的条目已被用户删除（${hit.id}），不能作为新候选复活`,
          hit.id
        )
      }
      if (!value.supersedes.includes(hit.id)) {
        return fail(
          'duplicate',
          `同样的文字已存在（${hit.id}，状态 ${hit.status}）：要替代它请显式写进 supersedes`,
          hit.id
        )
      }
    }
  }

  const promoted =
    confirmed ||
    (value.confidenceClass === 'verified' && ctx.hostCheck?.evidenceVerified === true && value.evidence.length > 0)
  const status: KnowledgeStatus = creating || current?.status === 'candidate' ? (promoted ? 'active' : 'candidate') : 'active'

  const entry: ProjectKnowledge = {
    schemaVersion: PROJECT_KNOWLEDGE_SCHEMA_VERSION,
    id,
    projectId: manifest.projectId,
    revision: (current?.revision ?? 0) + 1,
    kind: value.kind,
    status,
    text: value.text,
    textDigest: value.textDigest,
    tags: value.tags,
    evidence: value.evidence,
    confidenceClass: confirmed ? 'user-confirmed' : value.confidenceClass,
    createdAt: current?.createdAt ?? ctx.now,
    updatedAt: ctx.now,
    ...(value.validFor ? { validFor: value.validFor } : {}),
    ...(value.supersedes.length > 0 ? { supersedes: value.supersedes } : {})
  }

  const replacing = new Set(superseded.map((target) => target.id))
  const entries = [
    ...manifest.entries.filter((pointer) => pointer.id !== id && !replacing.has(pointer.id)),
    ...superseded.map(pointerOf),
    pointerOf(entry)
  ]
  if (entries.length > PROJECT_KNOWLEDGE_LIMITS.maxEntries) {
    return fail(
      'too_many_entries',
      `一个项目最多 ${PROJECT_KNOWLEDGE_LIMITS.maxEntries} 条知识，这次会变成 ${entries.length} 条`
    )
  }

  return {
    ok: true,
    manifest: {
      ...manifest,
      revision: manifest.revision + 1,
      updatedAt: ctx.now,
      entries
    },
    entry,
    superseded
  }
}

export interface KnowledgeDeleteRequest {
  id: unknown
  expectedRevision: unknown
  mode: unknown
  userAction?: { by: 'user' } | null
}

export interface KnowledgeDeleteContext {
  now: string
  current: ProjectKnowledge | null
}

export type KnowledgeDeleteResult =
  | {
      ok: true
      manifest: ProjectKnowledgeManifest
      entry: ProjectKnowledge
      purgePreviousRevisions: boolean
    }
  | KnowledgeFailure

export function applyKnowledgeDelete(
  manifest: ProjectKnowledgeManifest,
  request: KnowledgeDeleteRequest,
  ctx: KnowledgeDeleteContext
): KnowledgeDeleteResult {
  if (request.mode !== 'logical' && request.mode !== 'permanent') {
    return fail('bad_mode', `mode 必须是 logical / permanent（收到 ${JSON.stringify(request.mode)}）`)
  }
  if (!isSafeKnowledgeId(request.id)) {
    return fail('bad_knowledge_id', `条目 id 非法：${JSON.stringify(request.id)}`)
  }
  const expected = parseExpectedRevision(request.expectedRevision)
  if (!expected.ok) return expected
  if (expected.value === 0) return fail('bad_expected_revision', '删除必须带磁盘上的当前 revision')
  if (!ctx.current) return fail('entry_not_found', `没有这条知识：${request.id}`, request.id)
  if (ctx.current.revision !== expected.value) {
    return fail(
      'stale_revision',
      `revision 冲突：磁盘上是 ${ctx.current.revision}，这次删除基于 ${expected.value}`,
      request.id
    )
  }
  if (ctx.current.status === 'deleted') {
    return fail('deleted_entry', `条目已经删过了：${request.id}`, request.id)
  }
  const permanent = request.mode === 'permanent'
  if (permanent && request.userAction?.by !== 'user') {
    return fail('not_user_action', '永久删除必须由明确的用户动作发起')
  }

  const current = ctx.current
  const tombstone: KnowledgeTombstone = {
    at: ctx.now,
    digest: current.textDigest,
    textLength: charLength(current.text)
  }
  const entry: ProjectKnowledge = {
    ...current,
    revision: current.revision + 1,
    status: 'deleted',
    text: permanent ? '' : current.text,
    evidence: permanent ? [] : current.evidence,
    updatedAt: ctx.now,
    tombstone
  }

  const entries = [...manifest.entries.filter((pointer) => pointer.id !== current.id), pointerOf(entry)]
  return {
    ok: true,
    manifest: { ...manifest, revision: manifest.revision + 1, updatedAt: ctx.now, entries },
    entry,
    purgePreviousRevisions: permanent
  }
}

export function knowledgeNeedsReview(
  entry: ProjectKnowledge,
  current: { branch?: string; commit?: string; existingPaths?: readonly string[] }
): boolean {
  if (entry.status !== 'active' && entry.status !== 'candidate') return false
  const validFor = entry.validFor
  if (!validFor) return false
  if (validFor.branch && current.branch && validFor.branch !== current.branch) return true
  if (validFor.commit && current.commit && validFor.commit !== current.commit) return true
  if (validFor.paths !== undefined && (!Array.isArray(validFor.paths) || validFor.paths.some((path) => typeof path !== 'string' || !isSafeRelativeRef(path)))) return true
  if (Array.isArray(validFor.paths) && validFor.paths.length > 0) {
    if (current.existingPaths === undefined) return false
    const existing = new Set(current.existingPaths)
    if (validFor.paths.some((path) => !existing.has(path))) return true
  }
  return false
}
