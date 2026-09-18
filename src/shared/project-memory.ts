/**
 * 项目知识（project knowledge）的**契约层 + 纯逻辑**（实施-03 S2）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这个文件里有什么
 * ══════════════════════════════════════════════════════════════════
 *  ① **形状与常量**：条目、来源证据、manifest 指针、墓碑、上限；
 *  ② **输入校验**（严格）：不可信的模型 / 工具入参 → 确定的草稿或可读错误；
 *  ③ **状态迁移 + revision 计算**（纯函数）：候选 / 生效 / 被替代 / 已删除，
 *     CAS（`expectedRevision`）、文本指纹去重、`supersedes` 显式关联；
 *  ④ **身份解析**：`projectId` 只认**项目登记**里的 id，
 *    不接受模型自报，也不信任任意 `cwd`；
 *  ⑤ **读回**（宽容）：不可变 revision 文件 → 条目，认不了就 `undefined`。
 *
 * 它**不碰** electron / pi / 文件系统 —— 落盘与进程锁在
 * [project-memory-store.ts](../main/project-memory-store.ts)，检索在 S3，
 * CLI 在 S4，UI 在 S5。规则只有这一份，主进程 / `yan` CLI / 单测共用。
 *
 * ── 三条贯穿全文的取舍 ──
 * · **宁可不猜**：认不出的状态、不是整数的 revision、对不上的 schema 版本，
 *   都报错或按「不认识」处理 —— 猜错的长期知识比没有更糟（它会进后续每轮上下文）；
 * · **模型没有身份与置信权**：`projectId` 与 `confidenceClass: 'user-confirmed'`
 *   只能由宿主按登记与会话原话给出（实施-03 §3 硬规则）；
 * · **不静默覆盖**：更新必须 CAS，冲突把当前版本交回调用方去合并；
 *   语义冲突（同指纹、已删除、已替代）一律**拒绝 + 指出是哪一条**，不自动替换。
 *
 * ── 这不是「记忆回来了」──
 * 旧全局记忆系统（`remember` / `recall` / `forget`、`memory.json`）**不恢复**
 * （AGENTS.md 第五节）；本模块是独立新功能，也**不读取**旧存储。
 */
import type { ProjectRecord } from './ipc'

/** manifest 与条目文件的 schema 版本。对不上就按「不认识」处理，不做静默猜测。 */
export const PROJECT_KNOWLEDGE_SCHEMA_VERSION = 1

/**
 * 上限。
 *
 * 超限**返回可读错误**，不悄悄截断：静默截断会让写入方以为存上了，
 * 而检索侧看到的又是另一份内容（与任务计划的立场一致）。
 */
export const PROJECT_KNOWLEDGE_LIMITS = {
  /** 单条正文最长多少 **code point**（CJK / emoji 都算一个）。 */
  maxTextLength: 4000,
  /** 单条标签数 / 单个标签长度。 */
  maxTags: 16,
  maxTagLength: 64,
  /** 单条来源证据数 / 单条摘录长度。 */
  maxEvidence: 16,
  maxEvidenceExcerpt: 500,
  /** `validFor.paths` 的条数与单个引用的长度。 */
  maxValidForPaths: 32,
  maxRefLength: 512,
  /** 一条知识最多显式替代几条。 */
  maxSupersedes: 16,
  /** 一个项目最多存多少条（含已删除的墓碑）。 */
  maxEntries: 500
} as const

export const KNOWLEDGE_KINDS = ['decision', 'constraint', 'fact', 'procedure'] as const
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number]

export const KNOWLEDGE_STATUSES = ['candidate', 'active', 'superseded', 'deleted'] as const
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number]

/**
 * 置信类。
 *
 * `user-confirmed` **不是**模型能写的：它表示「用户在会话里明确要求记住」，
 * 由宿主带着原话授予（见 [applyKnowledgeCommit] 的 `hostCheck`）。
 */
export const CONFIDENCE_CLASSES = ['user-confirmed', 'verified', 'inferred'] as const
export type ConfidenceClass = (typeof CONFIDENCE_CLASSES)[number]

/**
 * 来源证据。
 *
 * 全是**引用**，不是授权：`file` 只是一个路径字符串，读到它并不赋予读取权限
 * （实施-03 §4）；真实边界由读取层按项目登记校验。
 */
export interface KnowledgeEvidence {
  sessionId?: string
  entryId?: string
  file?: string
  digest?: string
  excerpt?: string
}

/** 适用范围：分支限定的事实不得被当成全局规则（实施-03 §4）。 */
export interface KnowledgeValidFor {
  branch?: string
  commit?: string
  paths?: string[]
}

/**
 * 无正文墓碑。
 *
 * 永久删除后唯一留下的东西：**没有正文**，只有指纹与长度。
 * 它的唯一用途是挡住「旧候选重新生成」—— 同一段文字再提一次会被拒
 * （[applyKnowledgeCommit] 的 `revives_deleted`）。
 */
export interface KnowledgeTombstone {
  at: string
  digest: string
  /** 被删正文的 code point 长度（诊断用；正文本身已经不在磁盘上）。 */
  textLength: number
}

/** 一条项目知识（不可变 revision 文件里的形状）。 */
export interface ProjectKnowledge {
  schemaVersion: number
  id: string
  projectId: string
  /** 从 1 开始，每次写入 +1；旧 revision 文件永不重写。 */
  revision: number
  kind: KnowledgeKind
  status: KnowledgeStatus
  text: string
  /** 正文的归一化指纹（去重与墓碑判据）。 */
  textDigest: string
  tags: string[]
  evidence: KnowledgeEvidence[]
  confidenceClass: ConfidenceClass
  createdAt: string
  updatedAt: string
  validFor?: KnowledgeValidFor
  /** 显式替代关系；**不按文本相似度**推断（实施-03 §3）。 */
  supersedes?: string[]
  tombstone?: KnowledgeTombstone
}

/**
 * manifest 里的一条指针（**不含正文**）。
 *
 * 为什么正文不放在 manifest 里：manifest 每次提交都要整份原子替换，
 * 把正文塞进去等于每次都重写全部内容，一处写坏就全丢；
 * 而 revision 文件是不可变的，坏一份只影响一条。
 * 指针里的 `digest` 让**去重与墓碑判定不必读正文文件**。
 */
export interface KnowledgePointer {
  id: string
  revision: number
  status: KnowledgeStatus
  kind: KnowledgeKind
  confidenceClass: ConfidenceClass
  digest: string
  createdAt: string
  updatedAt: string
  /** 已删除条目才有（无正文墓碑的时间戳）。 */
  tombstoneAt?: string
}

/**
 * 项目知识的 manifest：当前指针集合。
 *
 * 它是**索引**：丢了可以按 revision 文件重建（见 store 的 `rebuildManifest`），
 * 所以崩溃恢复的立场与「正文」不同 —— manifest 允许被重建，正文不允许被猜。
 */
export interface ProjectKnowledgeManifest {
  schemaVersion: number
  projectId: string
  /** 每次成功提交 +1（诊断与 CAS 冲突信息用）。 */
  revision: number
  updatedAt: string
  entries: KnowledgePointer[]
}

/* ══════════════════════════════════════════════════════════════════
 * 一、错误码
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 请求级失败码（**不是**存储失败）。
 *
 * 存储失败（读不了 / 写不进 / 抢不到锁）在 store 里抛
 * `ProjectKnowledgeStoreError` —— 两类必须能分开：
 * 「你的请求不对」是调用方该改的，「磁盘写不进去」是环境问题，
 * 前者让模型自我纠正，后者不能让模型以为存上了。
 */
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
  /** 冲突时指向「是哪一条」——调用方据此读回最新版本去合并。 */
  existingId?: string
}

function fail(code: ProjectKnowledgeErrorCode, message: string, existingId?: string): KnowledgeFailure {
  return existingId ? { ok: false, code, message, existingId } : { ok: false, code, message }
}

/* ══════════════════════════════════════════════════════════════════
 * 二、标识与指纹
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 项目 id 直接进目录名，所以必须先挡住路径穿越。
 *
 * 真实 id 由 `settings.projects` 给（`project-<base64url 36>`，见 project-id.ts），
 * 这里放宽到 `[A-Za-z0-9._-]` 以免以后上游换 id 形状时误伤，
 * 但仍然排除分隔符与 `.` / `..`。
 */
const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/

export function isSafeProjectId(value: unknown): value is string {
  return typeof value === 'string' && PROJECT_ID_RE.test(value) && !value.includes('..')
}

/** 条目 id 同样直接进目录 / 文件名（`entries/<id>/r<n>.json`）。 */
const KNOWLEDGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/

export function isSafeKnowledgeId(value: unknown): value is string {
  return typeof value === 'string' && KNOWLEDGE_ID_RE.test(value) && !value.includes('..')
}

/**
 * 证据里的文件引用：相对项目根的路径。
 *
 * 这一层只做**明显的越界**拦截（绝对路径 / `..` / NUL）—— 它是防御，
 * 不是授权判据；真实边界（符号链接、项目外路径）由读取层按项目登记校验
 * （实施-03 §4：「文本引用不授予读取权限」）。
 */
export function isSafeRelativeRef(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const ref = value.trim()
  if (!ref || ref.length > PROJECT_KNOWLEDGE_LIMITS.maxRefLength) return false
  if (ref.includes('\u0000')) return false
  if (ref.startsWith('/') || ref.startsWith('\\')) return false
  if (/^[A-Za-z]:[\\/]/.test(ref)) return false
  return !ref.split(/[\\/]+/).some((part) => part === '..')
}

/**
 * 正文的归一化形式：NFKC + 空白折叠 + 去首尾。
 *
 * 只用于**指纹**，不改存正文原文（界面与模型永远看到原文）。
 * 不做小写化：代码标识符与路径大小写敏感，改小写会把两条不同的知识判成一条。
 */
export function normalizeKnowledgeText(text: string): string {
  return text.normalize('NFKC').replace(/\s+/gu, ' ').trim()
}

const FNV_OFFSET = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n
const MASK64 = 0xffffffffffffffffn

/**
 * 文本指纹：FNV-1a 64 位，16 个十六进制字符。
 *
 * ⚠️ 这**不是**密码学哈希，也不承担安全职责；它只是「同一段文字」的
 * 稳定判据（去重、墓碑）。用纯 JS 而不是 `node:crypto` 是为了让这个
 * 模块保持平台中立（渲染端 / `yan` CLI / 单测都能直接 import）。
 * 碰撞的后果是偏保守的方向：重复知识被拒、或墓碑误挡一条新知识，
 * 而不是把两条不同的知识混成一条。
 */
export function textDigest(text: string): string {
  const normalized = normalizeKnowledgeText(text)
  let hash = FNV_OFFSET
  for (const ch of normalized) {
    hash = ((hash ^ BigInt(ch.codePointAt(0) ?? 0)) * FNV_PRIME) & MASK64
  }
  /* 长度参与端部混合：极短的输入（单个字符）也散得开 */
  hash = ((hash ^ BigInt([...normalized].length)) * FNV_PRIME) & MASK64
  return hash.toString(16).padStart(16, '0')
}

/** 按 **code point** 数长度：`'👍'` 是 1 而不是 `String.length` 的 2。 */
function charLength(text: string): number {
  return [...text].length
}

/* ══════════════════════════════════════════════════════════════════
 * 三、项目身份（只认登记，不认自报）
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 宿主解析出的项目身份。
 *
 * 存储层只接受这个形状 —— 它**必须**来自 `resolveProjectIdentity`，
 * 而不是「某个字符串参数」。模型 / CLI 传什么都进不到这里：
 * S4 的 CLI 由宿主绑定当前身份（实施-03 §6）。
 */
export interface ProjectIdentity {
  projectId: string
  cwd: string
}

/**
 * 把调用方给的 `projectId` 与**项目登记**比对。
 *
 * 三条都是硬规则（实施-03 §3 / §4）：
 *  ① 只认登记里的 id（`null` / 未登记 / 形状非法一律拒）；
 *  ② **不**按 `cwd` 反推 —— 传 `{cwd}` 不是身份，是越权尝试；
 *  ③ 已归档的项目仍然认（用户没删它，知识也还在），
 *     但返回里有 `archived` 供调用方决定要不要提示。
 */
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

/**
 * 反方向：只有**已登记**的 cwd 才能换出 id，未登记的目录不开启跨项目检索
 * （实施-03 §4）。找不到就回 `undefined`，**不**现场派生一个新 id ——
 * 现场派生就是「信任任意 cwd」。
 */
export function registeredProjectIdForCwd(
  cwd: unknown,
  registry: readonly ProjectRecord[]
): string | undefined {
  if (typeof cwd !== 'string' || !cwd) return undefined
  const hit = registry.find((project) => project.cwd === cwd)
  return hit && isSafeProjectId(hit.id) ? hit.id : undefined
}

/* ══════════════════════════════════════════════════════════════════
 * 四、manifest（指针集合）
 * ══════════════════════════════════════════════════════════════════ */

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

/** 指纹 → 指针（去重与墓碑判定的索引）；同一指纹不可能有两条（写入侧保证）。 */
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

/**
 * manifest 的校验（读盘用）。
 *
 * 整份校验、不做部分采用：manifest 是索引，与其采用半份损坏的索引
 * （少几条知识、状态还错），不如让上层退回备份 / 从 revision 文件重建。
 */
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

/* ══════════════════════════════════════════════════════════════════
 * 五、草稿校验（严格，只用于新写入）
 * ══════════════════════════════════════════════════════════════════ */

/** 调用方给的草稿（模型 / 工具参数；**没有**身份、置信权、时间与 id）。 */
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

/**
 * 校验一条草稿。
 *
 * 与 [readKnowledgeFile] 的区别就是**这里不宽容**：这一侧是新写入，
 * 宁可让模型重写一次，也不能把糊掉的数据长期存进去（它会进后续每轮上下文）。
 */
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
      evidence.excerpt = e.excerpt
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

/* ══════════════════════════════════════════════════════════════════
 * 六、读回（宽容：读的是已经落盘的数据）
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 一个不可变 revision 文件 → 条目。
 *
 * 认不了就回 `undefined`，**不**编造：调用方（store 的重建路径）据此
 * 退回更早的 revision，而不是采用一份读歪的知识。
 * 坏项（标签 / 证据）逐条丢掉，不因此丢掉整条 —— 与「新写入严格」不矛盾：
 * 这条路径读的是别人（本产品的旧版本或手改过的文件）写下的东西。
 */
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
  /* 正文为空只允许出现在「永久删除的墓碑」上 —— 其余情况按坏文件处理 */
  if (raw.text.trim().length === 0 && !(raw.status === 'deleted' && tombstone)) return undefined

  const tags = Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === 'string') : []
  const evidence = Array.isArray(raw.evidence)
    ? raw.evidence.filter((e): e is KnowledgeEvidence => !!e && typeof e === 'object' && !Array.isArray(e))
    : []
  const validFor = raw.validFor && typeof raw.validFor === 'object' ? (raw.validFor as KnowledgeValidFor) : undefined
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

/* ══════════════════════════════════════════════════════════════════
 * 七、状态迁移（纯 reducer）
 * ══════════════════════════════════════════════════════════════════ */

/** 宿主侧的核实结果 —— 模型无法构造这两个字段（它们是主进程内部的参数）。 */
export interface KnowledgeHostCheck {
  /** 用户在会话中明确要求记住，带**原话**：唯一能写 `user-confirmed` 的路径。 */
  userConfirmed?: { sessionId?: string; quote: string } | null
  /** 宿主核实过 evidence 的引用确实存在：唯一能把 `verified` 升为 active 的路径。 */
  evidenceVerified?: boolean
}

export interface KnowledgeCommitRequest {
  /** 新建可以省略（宿主生成）；更新必须给，且必须与磁盘上的当前条目一致。 */
  id?: unknown
  kind: unknown
  text: unknown
  tags?: unknown
  evidence?: unknown
  confidenceClass?: unknown
  validFor?: unknown
  supersedes?: unknown
  /** CAS：`0` = 新建；`>0` = 必须等于磁盘上该条目的当前 revision。 */
  expectedRevision: unknown
}

export interface KnowledgeCommitContext {
  /** 宿主生成的新 id（新建时用）——**不由模型给**。 */
  newId: string
  now: string
  /** 磁盘上该 id 的当前条目（新建 / id 不存在时 `null`）。 */
  current: ProjectKnowledge | null
  /** 指纹 → 指针（去重与墓碑判定）。 */
  digests: ReadonlyMap<string, KnowledgePointer>
  /** `supersedes` 指向的条目（由 store 从 revision 文件读回）。 */
  supersedesTargets: ReadonlyMap<string, ProjectKnowledge>
  hostCheck?: KnowledgeHostCheck
}

export type KnowledgeCommitResult =
  | {
      ok: true
      manifest: ProjectKnowledgeManifest
      entry: ProjectKnowledge
      /** 被这次提交显式替代掉的条目（也要写各自的新 revision）。 */
      superseded: ProjectKnowledge[]
    }
  | KnowledgeFailure

/** `expectedRevision` 必须是 `0` 或正整数 —— 字符串 `"1"` 不算（模型经常这么传）。 */
function parseExpectedRevision(raw: unknown): { ok: true; value: number } | KnowledgeFailure {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    return fail('bad_expected_revision', `expectedRevision 必须是从 0 开始的整数（收到 ${JSON.stringify(raw)}）`)
  }
  return { ok: true, value: raw }
}

/**
 * 应用一次提交（新建 / 更新），返回**新的 manifest + 要写的条目**。
 *
 * 纯函数：不碰磁盘、不读文件（`current` 与 `supersedesTargets` 由调用方
 * 从磁盘读回）。这样「校验 + CAS + 状态迁移」只有一份实现，
 * store 只负责把结果写下去。
 *
 * 六条硬规则（实施-03 §3）在这里各自落到一行：
 *  ① CAS：`expectedRevision` 对不上 → `stale_revision`（不静默覆盖）；
 *  ② 模型不能写 `user-confirmed`（没有宿主原话 → `unconfirmed_confidence`）；
 *  ③ 不能悄悄把已确认的条目降级（`downgrade_confirmed`）；
 *  ④ 文本指纹去重（`duplicate`），且**跨删除**挡旧候选复活（`revives_deleted`）；
 *  ⑤ `supersedes` 必须显式且指向真实存在的条目（`unknown_supersedes`）；
 *  ⑥ `revision` 只在成功提交时 +1，条目与 manifest 各自记账。
 */
export function applyKnowledgeCommit(
  manifest: ProjectKnowledgeManifest,
  request: KnowledgeCommitRequest,
  ctx: KnowledgeCommitContext
): KnowledgeCommitResult {
  const expected = parseExpectedRevision(request.expectedRevision)
  if (!expected.ok) return expected

  /* ---- 身份：id 由请求给（更新）或宿主生成（新建），模型不能借 id 越权 ---- */
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

  /* ---- 草稿校验（严格） ---- */
  const draft = validateKnowledgeDraft(request)
  if (!draft.ok) return draft
  const value = draft.value
  const current = ctx.current

  /* ---- 置信类：只有宿主能授予 user-confirmed / verified 的生效 ---- */
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

  /* ---- 显式替代关系 ---- */
  const superseded: ProjectKnowledge[] = []
  for (const targetId of value.supersedes) {
    if (targetId === id) return fail('bad_supersedes', '不能替代自己')
    const target = ctx.supersedesTargets.get(targetId)
    if (!target) return fail('unknown_supersedes', `supersedes 指向不存在的条目：${targetId}`, targetId)
    if (target.status === 'deleted') {
      return fail('supersedes_deleted', `supersedes 指向已删除的条目：${targetId}`, targetId)
    }
    if (target.status === 'superseded') continue
    superseded.push({ ...target, status: 'superseded', revision: target.revision + 1, updatedAt: ctx.now })
  }

  /* ---- 文本指纹：同指纹不接受，已删除的墓碑更不接受（旧候选不复活） ---- */
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

  /* ---- 状态迁移 ---- */
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
    confidenceClass: value.confidenceClass,
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
  /** `logical` = 逻辑删除（正文 revision 还留着，可恢复）；`permanent` = 永久删除。 */
  mode: unknown
  /** 永久删除**只按明确用户动作**执行（界面上的「永久删除」按钮）。 */
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
      /** `true` = 写完墓碑后要清掉该条目的旧 revision 文件（正文真的不再留）。 */
      purgePreviousRevisions: boolean
    }
  | KnowledgeFailure

/**
 * 应用一次删除。
 *
 * 两种语义（实施-03 §3「删除语义」）：
 *  · **逻辑删除**：从可检索集立刻移除（store 的 `listKnowledge` 不再返回它），
 *    但正文 revision 还在磁盘上 —— 用户改主意时恢复得回来；
 *  · **永久删除**：新 revision 是**无正文墓碑**（只剩指纹与长度），
 *    旧 revision 文件由 store 清掉。之后同一段文字再提交会被
 *    `revives_deleted` 挡住（防止旧候选从别处复活）。
 *
 * 两条路径都写一份**新 revision**（而不是原地改状态）：
 * 状态变化也是历史，审计时能看到「谁在什么时候删的」。
 */
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
    /* 永久删除不留正文，也不留摘录（摘录里可能正是正文） */
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

/**
 * 派生状态：这条知识需不需要复核。
 *
 * 「文件 / 分支状态变化把相关条目标为需复核（派生状态），**不删除**用户决定」
 * （实施-03 §3）。判定放在纯逻辑层，是因为它会被检索（S3）与界面（S5）
 * 各用一次 —— 两处各判一次必然分叉。
 */
export function knowledgeNeedsReview(
  entry: ProjectKnowledge,
  current: { branch?: string; commit?: string; existingPaths?: readonly string[] }
): boolean {
  if (entry.status !== 'active' && entry.status !== 'candidate') return false
  const validFor = entry.validFor
  if (!validFor) return false
  if (validFor.branch && current.branch && validFor.branch !== current.branch) return true
  if (validFor.commit && current.commit && validFor.commit !== current.commit) return true
  if (validFor.paths && validFor.paths.length > 0) {
    if (current.existingPaths === undefined) return false
    const existing = new Set(current.existingPaths)
    if (validFor.paths.some((path) => !existing.has(path))) return true
  }
  return false
}
