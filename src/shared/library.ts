/**
 * 资料库（Library）—— 契约、不变量与纯逻辑（实施-25 P03）。
 *
 * ## 为什么这一片是「全设计最关键的落地风险点」
 *
 * 研究、创作、学习、成果全部建立在「来源」之上。如果资料的身份或版本搞错，
 * 后面每一个功能都会建在漂移的来源上：报告引用的第 N 页会指向另一份文件的第 N 页，
 * 学习材料会在用户不知情时换掉，成果里的引用会指向同名的另一份文件。
 * 所以本文件的三条不变量**先于**任何解析器实现：
 *
 * 1. **唯一事实源（T03-1）**：`LibrarySource` + 它的版本是资料的唯一事实源。
 *    会话 / 课程 / 成果**只存引用**（`{ sourceId, version }`），不复制标题、
 *    不复制路径、不复制 ownership。
 * 2. **引用绑 identity + version（T03-2）**：打开一份旧引用时，只能按
 *    `sourceId + version` 查表；**禁止**按标题或路径重新找文件 —— 那是两件事：
 *    路径用于判断「这是不是同一份内容」（导入时），引用用于「打开当时读到的那一份」。
 * 3. **不做一次性搬迁（T03-3）**：旧的会话级 `SourceRef`（`main/sources.ts`）
 *    保持原样；首次被资料库接管时才建一条 `LegacySourceMap`，让老引用仍可解释。
 *    一次性搬迁会把「老会话里的图片/文件」全押在一次迁移的正确性上。
 *
 * 另外两条来自 §1 边界与不变量：
 *   · **软移除**（T03-6）：从空间移除只标记，不删版本 —— 旧引用必须还能打开。
 *     原件被删/改名也不重指同名新文件，只如实标「原件不可用」。
 *   · **状态如实显示**（T03-5）：已添加 / 可阅读 / 无法提取正文，
 *     加上「已从空间移除」「原件已删除」两种历史态；不许静默降级成「已添加」。
 */
import { normalizeLayoutPath } from './session-path'

/** 资料的载体类型。决定「谁持有字节」与「怎么解析」。 */
export type LibraryKind = 'file' | 'web' | 'text' | 'image'

/**
 * 解析状态。
 *
 * `unsupported` 与 `failed` 必须区分：
 *   · unsupported = 这类资料我们本来就不提取正文（扫描件 / Office），是**承诺范围**问题；
 *   · failed = 应该能提取但没成功（坏了 / 编码异常），是**实现或数据**问题。
 * 合成一个会让用户以为「这个格式不支持」，而实际上是解析坏了。
 */
export type LibraryParseStatus = 'pending' | 'ok' | 'unsupported' | 'failed'

export interface LibraryParse {
  status: LibraryParseStatus
  /** 提取出的正文写到哪（相对 `YAN_DIR`）；只有 `ok` 才有 */
  textPath?: string
  chars?: number
  pages?: number
  /** 给人看的说明（为什么会是 unsupported / failed）。不吞错误原因。 */
  note: string
  at: number
}

/** 资料实体（身份）。**身份一旦建立就不随内容变化**。 */
export interface LibrarySource {
  id: string
  /** 归属空间；可空 = 还没归档到具体空间（例如从会话里直接加进来的） */
  spaceId?: string
  kind: LibraryKind
  /** 展示标题，用户可改；**不用于任何查找** */
  title: string
  createdAt: number
  updatedAt: number
  /** 从空间移除的时间。软移除：旧引用仍可打开。 */
  removedAt?: number
  /** 原件（用户原文件）最后一次探测不可用的时间。 */
  unavailableAt?: number
}

/**
 * 一个版本的内容与状态。
 *
 * `identity` / `ref` / `fingerprint` / `size` 是**内容事实**，建档后不再改；
 * `available` / `parse` / `checkedAt` 是**状态**，可以被后续探测更新。
 * 这条分界必须守住：改内容事实只能新建版本（否则旧引用会被无声改写）。
 */
export interface LibraryVersion {
  sourceId: string
  version: number
  /**
   * 内容身份：判断「这是不是同一份内容」。
   * 文件 = `file:<归一化绝对路径>`；网页 = `web:<规范化 URL>`；
   * 文本 / 图片 = `<kind>:sha256(内容)`。
   */
  identity: string
  /** 打开用的引用：文件 = 绝对路径；网页 = URL；文本 / 图片 = 我们持有的副本相对路径 */
  ref: string
  title: string
  size?: number
  /** 内容指纹（宿主给，sha256 前缀）。identity 相同而指纹不同 = 内容变过 → 新版本。 */
  fingerprint: string
  addedAt: number
  /** 原件还在不在（文件才有意义；其余恒 true）。探测后更新。 */
  available: boolean
  checkedAt?: number
  parse: LibraryParse
}

/**
 * 引用：**只存这两个字段**。
 *
 * `version` 必须显式保存 —— 缺了它，用户更新文件后所有旧报告都会指向新版本，
 * 而那正是 T03-2 要禁止的。
 */
export interface SourceReference {
  sourceId: string
  version: number
}

/** 引用方。会话 / 课程 / 成果都只存引用，不复制资料本体。 */
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

/** 旧会话级 SourceRef → 资料库的映射（T03-3：不做一次性搬迁，用到才建）。 */
export interface LegacySourceMap {
  /** 旧 `sources.ts` 里的 sourceId */
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

/* ------------------------------------------------------------------ *
 * identity / 指纹
 * ------------------------------------------------------------------ */

/** 网页 URL 的规范化：去 fragment、host 小写、去末尾斜杠。查询串保留（是内容的一部分）。 */
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
    /* 不是合法 URL 就按原样（去掉 fragment 的朴素版本）—— 校验会在前面拦 */
    return trimmed.split('#')[0].replace(/\/+$/, '')
  }
}

/**
 * 内容身份。
 *
 * 为什么文件用路径：路径是「同一份文件被再次导入」的唯一可用锚点。
 * 但**它只用于导入判断**，绝不用于打开已有引用（见文件头不变量 2）。
 */
export function contentIdentity(kind: LibraryKind, value: string): string {
  if (kind === 'web') return `web:${normalizeWebUrl(value)}`
  if (kind === 'file') return `file:${normalizeLayoutPath(value)}`
  return `${kind}:${value.trim()}`
}

/** 引用的相等性 / 键。所有「是不是同一份、同一版」的判断都走这两个函数。 */
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

/* ------------------------------------------------------------------ *
 * 导入决策（纯函数，便于把「版本推进规则」钉死在单测里）
 * ------------------------------------------------------------------ */

export interface LibraryImportInput {
  kind: LibraryKind
  /** 由 `contentIdentity` 算好的身份 */
  identity: string
  fingerprint: string
  title: string
  /** 打开用的引用（文件路径 / URL / 副本相对路径） */
  ref: string
  size?: number
  spaceId?: string
  at?: number
}

export type LibraryImportDecision =
  /** 同一份内容的同一个版本：什么都不做（幂等） */
  | { kind: 'unchanged'; sourceId: string; version: number }
  /** 同一份内容但指纹变了：推进版本，旧版本保留 */
  | { kind: 'new-version'; sourceId: string; version: number }
  /** 新资料：建实体 + 第 1 版 */
  | { kind: 'new-source'; version: number }
  | { kind: 'rejected'; reason: string }

/**
 * 决定一次导入该做什么。
 *
 * 规则（只有三条，但它们就是这一片的核心）：
 *   · 同 identity + 同指纹 → 不动（重复导入不该产出第二份资料，也不该产生新版本）；
 *   · 同 identity + 不同指纹 → **新版本**（内容变过；旧版本与引用原样保留）；
 *   · 没见过的 identity → 新资料。
 *
 * ⚠️ 这里**故意不看 title**：标题相同的两份不同文件是两份资料。
 */
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

/* ------------------------------------------------------------------ *
 * 查询（全部按 id + version，禁止按标题/路径）
 * ------------------------------------------------------------------ */

export function sourceById(doc: LibraryDocument, sourceId: string): LibrarySource | undefined {
  return doc.sources.find((s) => s.id === sourceId)
}

export function versionsOf(doc: LibraryDocument, sourceId: string): LibraryVersion[] {
  return doc.versions.filter((v) => v.sourceId === sourceId).sort((a, b) => a.version - b.version)
}

/** 某份资料的最新版本（资料不可能没有版本，见 decideImport）。 */
export function latestVersionOf(doc: LibraryDocument, sourceId: string): LibraryVersion | undefined {
  const list = versionsOf(doc, sourceId)
  return list.length ? list[list.length - 1] : undefined
}

/**
 * 按引用取版本。**这是打开引用的唯一入口。**
 *
 * 返回 undefined 表示「这条引用在当前资料库里找不到」——
 * 界面必须显示成「引用不可用」，而不是回退去找同名文件（那份文件可能是另一份资料）。
 */
export function versionByRef(doc: LibraryDocument, ref: SourceReference): LibraryVersion | undefined {
  return doc.versions.find((v) => v.sourceId === ref.sourceId && v.version === ref.version)
}

/** 资料是否在「活动」状态（未被软移除）。 */
export function isActiveSource(source: LibrarySource | undefined): boolean {
  return !!source && source.removedAt === undefined
}

/** 活动资料（未被软移除）。`spaceId` 省略 = 不限空间；传 null = 未归档到空间的那些。 */
export function activeSources(doc: LibraryDocument, spaceId?: string | null): LibrarySource[] {
  return doc.sources
    .filter((s) => isActiveSource(s))
    .filter((s) => (spaceId === undefined ? true : (s.spaceId ?? null) === spaceId))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function refsForOwner(doc: LibraryDocument, owner: LibraryOwner): SourceReference[] {
  return doc.refs.filter((r) => sameOwner(r.owner, owner)).map((r) => r.ref)
}

/** 反向索引：哪些会话 / 课程 / 成果引用了这份资料（含各自引用的版本）。 */
export function ownersForSource(doc: LibraryDocument, sourceId: string): LibraryRefRecord[] {
  return doc.refs.filter((r) => r.ref.sourceId === sourceId)
}

/** 旧引用映射：某个旧 sourceId 被接管后对应到哪一版（T03-3）。 */
export function legacyMappingOf(
  doc: LibraryDocument,
  legacyId: string,
  sessionId: string
): LegacySourceMap | undefined {
  return doc.legacy.find((l) => l.legacyId === legacyId && l.sessionId === sessionId)
}

/**
 * 一条引用当前对用户意味着什么。
 *
 * 这是界面文案的**唯一依据** —— 避免「同一状态在三个地方显示成三种样子」。
 */
export type RefOutcome = 'ok' | 'removed' | 'unavailable' | 'unsupported' | 'pending' | 'failed' | 'missing'

/**
 * 判定顺序有意为之：
 *   · `missing` 最先（引用指向不存在的版本，说明数据不一致，必须显眼）；
 *   · `unavailable` 先于 `removed` —— 原件已被删是更具体、更需要行动的信息；
 *   · 解析状态最后（它是「能不能读正文」，不影响「这条引用还在不在」）。
 */
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

/**
 * 这条引用现在能不能作为**正文**交给模型读。
 *
 * 与 `refOutcome === 'ok'` 不等价：附件态（unsupported）仍然是能打开的引用，
 * 只是没有正文 —— 组装上下文时必须只带真正有正文的那些。
 */
export function refReadable(doc: LibraryDocument, ref: SourceReference): boolean {
  const version = versionByRef(doc, ref)
  return !!version && version.available && version.parse.status === 'ok' && !!version.parse.textPath
}
