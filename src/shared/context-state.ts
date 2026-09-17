/**
 * 上下文状态的 schema 与校验（N21-4 / S1：State 与 Archive 基础设施）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这一层解决什么问题
 * ══════════════════════════════════════════════════════════════════
 * 阶段 4 要把「送给模型的消息」从「一整条聊天记录」改成
 * `TASK_STATE → HISTORICAL_CONTEXT → RECENT_RAW`（方案 §12 / §13.4）。
 * 一旦状态要**跨回合活着**，它就必须能回答三个问题：
 *
 *   1. 这份状态说的是**哪个会话**、**哪一刻**的原始 session？（`sessionId` + `sourceWatermark`）
 *   2. 状态里的每条结论**从哪来**？（provenance：raw entry identity）
 *   3. 这份状态**还能不能用**？（schemaVersion / 水位 / TTL）
 *
 * 本文件是这三个问题的**纯逻辑**答案与唯一 schema 真源。
 * 它不做 IO、不认识 Electron、不调用模型 —— 落盘在
 * `src/main/context-state-store.ts`，从原始会话文件读水位的在
 * `src/main/context-watermark.ts`。
 *
 * ══════════════════════════════════════════════════════════════════
 * 三条硬约束（写代码时别绕过去）
 * ══════════════════════════════════════════════════════════════════
 * **① active context 是可丢失派生物，原始 session 才是 source of truth。**
 *   状态可以整份丢掉、可以重建；任何丢失都不能让用户损失历史。
 *
 * **② provenance 只能指向 raw entry identity。**
 *   不允许出现「第 12 条消息」「token offset 3000」「折叠后的第 3 段」
 *   这类定位：它们会随压缩、重排、pi 换版本而失效，而且无法追溯。
 *   所以本文件里**没有任何**按数组下标 / token 定位的字段，`entryId`
 *   一律是原始 session 文件里那条 entry 的 `id`（校验时要求它存在于
 *   调用方给出的原始条目身份列表里）。
 *
 * **③ 禁止递归摘要（§12.7）。**
 *   `EpisodeState.sourceRange` 必须指回**原始**条目。指到 `ctx://` 归档引用
 *   或另一份 EpisodeState 上就是「摘要的摘要」—— 直接判非法
 *   （`archive-ref` / `episode-ref`，见 `checkSourceRange`）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 本切片（S1）的边界
 * ══════════════════════════════════════════════════════════════════
 * 只定义「状态长什么样、怎么校验、能不能用」。
 * **不实现** Tool Sweep、Episode Fold、结构化压缩、Recall 注入，
 * **不改**发给模型的消息，也不做任何模型调用。
 * Deep Context 只在这里预留 artifact 类型与「能不能注入」的判据
 * （`deepContextUsable`），启动它的第二次模型调用属于后续切片。
 * 谁负责生成状态（主进程还是 pi 扩展提案）由后续切片决定 ——
 * 本文件与 store 只做「校验 + 存取」，不猜上游。
 */
/**
 * 校验失败的机器可读原因。测试与诊断按 code 断言，不去匹配文案。
 * 加值时要同步 `scripts/test-context-state.mjs` 的覆盖 —— 这个联合类型
 * 就是「校验器到底能报哪些问题」的清单。
 */
export type ValidationCode =
  | 'not-object'
  | 'missing'
  | 'type'
  | 'empty'
  | 'unknown-version'
  | 'unknown-raw-entry'
  | 'unknown-episode'
  | 'archive-ref'
  | 'episode-ref'
  | 'range-order'
  | 'bad-ref'
  | 'bad-status'
  | 'superseded-by'
  | 'model-confidence'
  | 'inconsistent-watermark'

/* ══════════════════════════════════════════════════════════════════
 * 版本
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 状态文件 / 归档文件的 schema 版本。
 *
 * 加值时**必须**同时想清楚「旧文件怎么办」：读到的版本不等于当前值时
 * 一律按「不兼容」安全丢弃（`inspectContextStateFile`），
 * 而不是尽力解析 —— 半懂不懂地读一份旧 schema 比丢掉它危险得多
 * （active context 是派生物，丢了会重建；读错会污染推理）。
 */
export const CONTEXT_STATE_SCHEMA_VERSION = 1
export const CONTEXT_ARCHIVE_SCHEMA_VERSION = 1

/* ══════════════════════════════════════════════════════════════════
 * 原始条目身份与水位
 * ══════════════════════════════════════════════════════════════════ */

/** 原始 session 文件里某条 entry 的 id（不透明字符串，调用方负责确认它真的存在） */
export type RawEntryId = string

/**
 * 原始 session 的水位：这份状态是从**哪一刻**的原始条目派生出来的。
 *
 * 为什么不用「时间戳」或「token 数」：两者都不可靠 ——
 * 时间戳会撞（同一毫秒多条）、token 数是估算且随模型变化。
 * `entryCount + lastEntryId` 直接对应文件里可数的条目：追加就会变，
 * 比对时能区分「旧快照」（raw 继续长了）与「对不上」（raw 被改写/回退）。
 */
export interface SourceWatermark {
  /** 派生时原始 session 里有多少条 entry（不含文件头 `type:"session"`） */
  entryCount: number
  /** 最后一条原始 entry 的 id；空会话为 null */
  lastEntryId: RawEntryId | null
}

/** 水位与当前原始 session 的关系 */
export type WatermarkRelation =
  /** 完全一致：状态对应的原始条目一条没多、一条没少 */
  | 'same'
  /** raw 在状态之后又长了：状态是**有效但较早**的快照 */
  | 'older'
  /** 对不上：raw 被裁剪 / 改写 / 换了一条会话，状态里的定位已经不可信 */
  | 'diverged'
  /** 水位本身形状非法（不是文件里读出来的那种） */
  | 'unknown'

/**
 * 一段原始条目的闭区间。`from` / `to` 都是**原始 entry id**，
 * 顺序按文件里的先后（`validateSourceRange` 会检查）。
 */
export interface SourceRange {
  from: RawEntryId
  to: RawEntryId
}

/* ══════════════════════════════════════════════════════════════════
 * provenance（每条结论从哪来）
 * ══════════════════════════════════════════════════════════════════ */

/** 一条状态信息的来源类别 */
export type StateSourceKind = 'user' | 'tool' | 'file' | 'model'

/**
 * 可信度：
 *   observed —— 用户说的 / 工具输出里直接看到的
 *   derived  —— 从 observed 事实推出的事实（例如「测试失败 → 该修复未生效」）
 *   hypothesis —— 模型自己的猜测，**没有原文可校验**
 */
export type StateConfidence = 'observed' | 'derived' | 'hypothesis'

/**
 * 一条状态的 provenance。
 *
 * 规则（§13.1 第 22 条「source 必须可校验」）：
 *   · `kind: 'user' | 'tool'` → **必须**有 `entryId`，且（给了原始身份列表时）它必须存在；
 *   · `kind: 'file'` → **必须**有 `path`（`entryId` 可选：文件内容也可能来自工具结果）；
 *   · `kind: 'model'` → 只能是 `hypothesis` —— 模型不能自称 `observed`。
 */
export interface StateProvenance {
  kind: StateSourceKind
  /** 原始 entry id；`user` / `tool` 必填 */
  entryId?: RawEntryId
  /** 文件路径；`file` 必填 */
  path?: string
  confidence: StateConfidence
}

/* ══════════════════════════════════════════════════════════════════
 * Task State（= 方案 §12.8 的 CodingState + §13.1 的生命周期字段）
 * ══════════════════════════════════════════════════════════════════ */

export type StateEntryStatus = 'active' | 'resolved' | 'superseded'

/**
 * 一条带生命周期与 provenance 的状态条目。
 *
 * 方案 §12.8 的字段名不变（`decisions` / `constraints` …），
 * 但每一项从「裸字符串」升级成本结构 —— 这是 §13.1 第 21、22 条
 * （状态不是长期记忆：可覆盖 / 失效 / 删除 + 防幻觉）的落地：
 * 没有 `status` 就删不掉旧决策（会被反复注入），
 * 没有 `source` 就无法回答「这条结论从哪来」。
 */
export interface StateEntry {
  text: string
  status: StateEntryStatus
  source: StateProvenance
  /** 最后更新时间（ms） */
  updatedAt: number
  /** 被哪一条取代（同文件内的 StateEntry 标识）；仅 superseded 时必填 */
  supersededBy?: string
}

/** 文件状态：读过 / 改过 / 建过 */
export interface FileState {
  path: string
  state: string
  source: StateProvenance
}

/** 跑过的命令（§13.1 第 23 条） */
export interface CommandRun {
  command: string
  exitCode?: number
  source: StateProvenance
}

/** 跑过的测试 */
export interface TestRun {
  command: string
  passed?: number
  failed?: number
  source: StateProvenance
}

/** 碰过的符号 */
export interface SymbolTouch {
  symbol: string
  path?: string
  source: StateProvenance
}

/**
 * Task State（文档里的 `CodingState` 就是它，见 §13.4：同一个东西，不新建第二张表）。
 *
 * 字段名沿用 §12.8；`commandsRun` / `testsRun` / `symbolsTouched` /
 * `assumptions` / `hypothesis` 是 §13.1 第 23 条补进来的。
 * 它回答 §12.8 的七个问题，而且**不是**对话摘要。
 */
export interface TaskState {
  task: { objective: string; currentPhase: string }
  currentState: StateEntry[]
  decisions: StateEntry[]
  constraints: StateEntry[]
  files: FileState[]
  completed: StateEntry[]
  failedAttempts: StateEntry[]
  unresolved: StateEntry[]
  nextActions: StateEntry[]
  commandsRun: CommandRun[]
  testsRun: TestRun[]
  symbolsTouched: SymbolTouch[]
  assumptions: StateEntry[]
  hypothesis: StateEntry[]
  /** 被折叠的 EpisodeState id 列表（只引用，不重新摘要它们） */
  episodeRefs: string[]
  /** `ctx://` 归档引用（需要查历史时去哪里） */
  archiveRefs: string[]
}

/** 文档里两种叫法都指它；保留别名免得以后有人又建一张表（§13.4） */
export type CodingState = TaskState

/* ══════════════════════════════════════════════════════════════════
 * Episode State（方案 §12.6）
 * ══════════════════════════════════════════════════════════════════ */

export interface EpisodeDecision {
  decision: string
  reason?: string
}

export interface EpisodeFileChange {
  path: string
  summary?: string
}

/**
 * 一段被折叠的 Episode 的**工作状态**（不是聊天摘要）。
 *
 * `sourceRange` 是 §12.7 的判据：必须指回原始 entry。
 * `watermark` 记下折叠时 raw 长到哪，便于事后回答「这段覆盖的是哪个版本的历史」。
 */
export interface EpisodeState {
  id: string
  objective: string
  outcome: string
  decisions: EpisodeDecision[]
  constraints: string[]
  filesChanged: EpisodeFileChange[]
  failedAttempts: string[]
  unresolved: string[]
  /** `ctx://` 引用（原文可以从归档里 Recall 回来） */
  importantRefs: string[]
  sourceRange: SourceRange
  watermark: SourceWatermark
  tokensBefore: number
  createdAt: number
}

/* ══════════════════════════════════════════════════════════════════
 * 状态文件（一个会话一份）
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 落在 `YAN_DATA_DIR/context-state/<sessionId>.json` 的整份状态。
 *
 * 派生物：损坏 / 版本不认识 / 水位对不上时**安全丢弃**，退回 pi 原生行为
 * （原始 session 一条不动）。
 */
export interface ContextStateFile {
  schemaVersion: number
  sessionId: string
  /**
   * 乐观并发版本号（N21-4 的 CAS / §16.6.1）。
   *
   * 为什么需要：生成状态是一次异步的模型调用（秒级到十几秒），
   * 它完成时会话可能已经又跑了好几个回合。「取消」只省算力，
   * **不能**当正确性机制 —— 真正拦住「迟到结果覆盖新快照」的是
   * 「读到的 revision = 提交前预期的 revision，否则丢弃」。
   * 旧文件（这个字段之前落盘的）没有它，按 0 处理。
   */
  revision?: number
  sourceWatermark: SourceWatermark
  createdAt: number
  updatedAt: number
  task: TaskState
  episodes: EpisodeState[]
}

/** 非法的状态文件（含 JSON 坏了、字段类型不对） */
export interface ValidationIssue {
  /** 出问题的字段路径，如 `task.decisions[0].source.entryId` */
  path: string
  code: ValidationCode
  message: string
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: ValidationIssue[] }

/** 状态文件读取判定的三态：能用 / 版本不认识 / 内容非法（后两者都要丢弃） */
export type ContextStateInspection =
  | { status: 'ok'; state: ContextStateFile }
  | { status: 'incompatible'; foundVersion: number; issues: ValidationIssue[] }
  | { status: 'invalid'; issues: ValidationIssue[] }

/* ══════════════════════════════════════════════════════════════════
 * Archive 元数据（方案附录 A 的 ArchiveEntry）
 * ══════════════════════════════════════════════════════════════════ */

export type ArchiveEntryKind = 'tool' | 'episode' | 'file' | 'diff'

/**
 * 三态而不是 boolean —— 「历史仍被保存」与「模型具备回溯能力」是两件事：
 *   none   不可恢复
 *   manual 仅砚/用户可恢复（历史已归档，模型取不回）
 *   agent  模型可通过 recall 工具主动取回
 * UI 只在 `agent` 时才能写「模型可回溯」。
 */
export type ArchiveRecallable = 'none' | 'manual' | 'agent'

/**
 * 归档**元数据**（S1 只到元数据，内容载荷按 §12.9 的 TTL 由后续切片管理）。
 *
 * `sourceRange` 让它可追溯回原始条目；`recallable` 决定谁能取回；
 * `expiresAt` 是召回内容的保质期（不填 = 只作为元数据长期留存）。
 */
export interface ArchiveEntry {
  /** 形如 `ctx://tool/<id>`，见 `validateCtxRef` */
  ref: string
  kind: ArchiveEntryKind
  label: string
  createdAt: number
  /** 内容过期时间（ms）；到点后不可注入，只剩元数据 */
  expiresAt?: number
  tokens: number
  recallable: ArchiveRecallable
  sourceRange: SourceRange
  watermark: SourceWatermark
  /** S1 不存原文；后续切片落内容时改 true，并受 TTL 约束 */
  contentStored: boolean
}

export interface ArchiveFile {
  schemaVersion: number
  sessionId: string
  updatedAt: number
  entries: ArchiveEntry[]
}

export type ArchiveInspection =
  | { status: 'ok'; archive: ArchiveFile }
  | { status: 'incompatible'; foundVersion: number; issues: ValidationIssue[] }
  | { status: 'invalid'; issues: ValidationIssue[] }

/* ══════════════════════════════════════════════════════════════════
 * Deep Context（只预留接口，S1 不实现第二次模型调用）
 * ══════════════════════════════════════════════════════════════════ */

/**
 * Pass 1 的产物（N21-8 才会真正生成它）。
 *
 * 在 S1 只定义形状与「能不能注入」的判据：即便以后生成器写错了，
 * 绑定信息不全 / 过期 / 水位对不上的 artifact 也进不了上下文。
 */
export interface DeepContextArtifact {
  sessionId: string
  sourceWatermark: SourceWatermark
  createdAt: number
  /** 过期后不得注入（软约束也有硬边界） */
  expiresAt: number
  content: string
}

export type DeepContextRejectReason =
  | 'not-object'
  | 'missing-field'
  | 'session-mismatch'
  | 'invalid-watermark'
  | 'watermark-mismatch'
  | 'not-created-yet'
  | 'expired'
  | 'empty-content'

export interface DeepContextCheck {
  sessionId: string
  watermark: SourceWatermark
  now: number
}

/* ══════════════════════════════════════════════════════════════════
 * 基本判定
 * ══════════════════════════════════════════════════════════════════ */

type Rec = Record<string, unknown>

function isRec(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

function isTimestamp(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0
}

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0
}

/**
 * 一条 entry id 的形状是否**可能**是原始条目。
 *
 * 这里**不能**检查「它是不是真的存在于会话文件里」——那需要原始条目索引
 * （`knownEntryIds`）。形状检查只拦最明显的错用：
 *   · 数字（`12`）—— 典型的「拿 messages 数组下标当定位」；
 *   · `ctx://…` —— 那是归档引用（§12.7 的递归摘要判据）；
 *   · 空串。
 */
export function isRawEntryIdShape(v: unknown): v is RawEntryId {
  if (typeof v !== 'string') return false
  const id = v.trim()
  if (!id) return false
  if (id.startsWith('ctx://')) return false
  return true
}

/** `ctx://<kind>/<id>` —— 归档引用的形状与类别要一致（§12.5） */
const CTX_REF_RE = /^ctx:\/\/(tool|episode|file|diff)\/([A-Za-z0-9._~%:-]{1,200})$/

export function validateCtxRef(raw: unknown, kind: ArchiveEntryKind | null, path: string, issues: IssueSink): string | null {
  if (typeof raw !== 'string' || !raw.trim()) {
    issues.add(path, 'type', '归档引用必须是非空字符串')
    return null
  }
  const m = CTX_REF_RE.exec(raw)
  if (!m) {
    issues.add(path, 'bad-ref', `不是合法的 ctx:// 引用：${raw}`)
    return null
  }
  if (kind && m[1] !== kind) {
    issues.add(path, 'bad-ref', `引用类别 ${m[1]} 与条目的 kind ${kind} 不一致`)
    return null
  }
  return raw
}

interface IssueSink {
  add(path: string, code: ValidationCode, message: string): void
}

class Issues implements IssueSink {
  readonly list: ValidationIssue[] = []
  add(path: string, code: ValidationCode, message: string): void {
    this.list.push({ path, code, message })
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 水位
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 从原始条目 id 列表算水位。
 *
 * 这是水位唯一的产生方式：调用方按文件顺序把 entry id 读出来（
 * `main/context-watermark.ts`），这里只做收尾。
 */
export function watermarkFromEntryIds(ids: readonly RawEntryId[]): SourceWatermark {
  const last = ids.length ? ids[ids.length - 1] : null
  return { entryCount: ids.length, lastEntryId: last && last.trim() ? last : null }
}

export function validateWatermark(raw: unknown, path: string, issues: IssueSink): SourceWatermark | null {
  if (!isRec(raw)) {
    issues.add(path, 'type', '水位必须是对象')
    return null
  }
  let bad = false
  if (!isCount(raw.entryCount)) {
    issues.add(`${path}.entryCount`, 'type', 'entryCount 必须是非负整数')
    bad = true
  }
  const last = raw.lastEntryId
  if (last !== null && !isNonEmptyString(last)) {
    issues.add(`${path}.lastEntryId`, 'type', 'lastEntryId 必须是原始 entry id 或 null')
    bad = true
  }
  if (bad) return null
  const count = raw.entryCount as number
  const lastId = last as string | null
  /* 不变式：空会话必须没有 lastEntryId；非空必须有 */
  if (count === 0 && lastId !== null) {
    issues.add(path, 'inconsistent-watermark', 'entryCount 为 0 时 lastEntryId 必须是 null')
    return null
  }
  if (count > 0 && lastId === null) {
    issues.add(path, 'inconsistent-watermark', 'entryCount 大于 0 时必须给出 lastEntryId')
    return null
  }
  return { entryCount: count, lastEntryId: lastId }
}

/**
 * 水位与当前 raw 的关系。
 *
 * 只有 `same` / `older` 说明状态里的定位还指得到东西；
 * `diverged` 必须丢弃（原始会话被改写/换了一条，旧定位失去了意义）。
 */
export function watermarkRelation(state: SourceWatermark, current: SourceWatermark): WatermarkRelation {
  if (!isCount(state?.entryCount) || !isCount(current?.entryCount)) return 'unknown'
  const sameTail = state.lastEntryId === current.lastEntryId
  if (state.entryCount === current.entryCount) return sameTail ? 'same' : 'diverged'
  /*
   * raw 更长：状态是一份**有效但较早**的快照（原始 session 只追加，不重写）。
   * 这里只做廉价的水位比较；「状态里的 entryId 是否真的还在」由调用方
   * 拿原始条目列表调 `checkSourceRange` / `validateProvenance` 强校验。
   */
  if (state.entryCount < current.entryCount) return 'older'
  /* 状态比 raw 还长：raw 被裁剪 / 回退，定位不再可信 */
  return 'diverged'
}

export function watermarksEqual(a: SourceWatermark, b: SourceWatermark): boolean {
  return a.entryCount === b.entryCount && a.lastEntryId === b.lastEntryId
}

/* ══════════════════════════════════════════════════════════════════
 * provenance 与 sourceRange
 * ══════════════════════════════════════════════════════════════════ */

export interface RawIndex {
  /** 原始 session 的 entry id，按文件顺序 */
  knownEntryIds?: readonly RawEntryId[]
  /** 已知的 EpisodeState id（用于拦「摘要的摘要」） */
  knownEpisodeIds?: readonly string[]
}

export function validateProvenance(raw: unknown, opts: RawIndex, path: string, issues: IssueSink): StateProvenance | null {
  if (!isRec(raw)) {
    issues.add(path, 'type', 'provenance 必须是对象')
    return null
  }
  const kinds: StateSourceKind[] = ['user', 'tool', 'file', 'model']
  const kind = raw.kind
  if (typeof kind !== 'string' || !kinds.includes(kind as StateSourceKind)) {
    issues.add(`${path}.kind`, 'type', `kind 必须是 ${kinds.join(' / ')}`)
    return null
  }
  const confidences: StateConfidence[] = ['observed', 'derived', 'hypothesis']
  const confidence = raw.confidence
  if (typeof confidence !== 'string' || !confidences.includes(confidence as StateConfidence)) {
    issues.add(`${path}.confidence`, 'type', `confidence 必须是 ${confidences.join(' / ')}`)
    return null
  }
  const entryId = raw.entryId
  const filePath = raw.path

  if (kind === 'model' && confidence !== 'hypothesis') {
    issues.add(path, 'model-confidence', '模型自己写的内容只能是 hypothesis（不能自称 observed）')
    return null
  }
  if (kind === 'user' || kind === 'tool') {
    if (!isRawEntryIdShape(entryId)) {
      issues.add(`${path}.entryId`, 'missing', `${kind} 来源必须给出原始 entryId`)
      return null
    }
  }
  if (kind === 'file' && !isNonEmptyString(filePath)) {
    issues.add(`${path}.path`, 'missing', 'file 来源必须给出 path')
    return null
  }
  if (entryId !== undefined && !isRawEntryIdShape(entryId)) {
    issues.add(`${path}.entryId`, 'type', 'entryId 必须是原始条目 id（不能是数组下标 / token 偏移 / ctx:// 引用）')
    return null
  }
  if (entryId !== undefined && opts.knownEntryIds && !opts.knownEntryIds.includes(entryId)) {
    issues.add(`${path}.entryId`, 'unknown-raw-entry', `原始会话里没有这条 entry：${String(entryId)}`)
    return null
  }
  if (filePath !== undefined && !isNonEmptyString(filePath)) {
    issues.add(`${path}.path`, 'type', 'path 必须是非空字符串')
    return null
  }

  return {
    kind: kind as StateSourceKind,
    confidence: confidence as StateConfidence,
    ...(entryId !== undefined ? { entryId: entryId as string } : {}),
    ...(filePath !== undefined ? { path: filePath } : {})
  }
}

/**
 * `sourceRange` 的合法性 —— 也**就是**「禁止递归摘要」的判据（§12.7）。
 *
 * 返回 null 表示合法；否则给出拒绝码与原因。
 */
export function checkSourceRange(
  range: unknown,
  opts: RawIndex
): { ok: true; range: SourceRange } | { ok: false; code: ValidationCode; message: string } {
  if (!isRec(range)) return { ok: false, code: 'type', message: 'sourceRange 必须是对象' }
  const { from, to } = range
  for (const [key, value] of [['from', from], ['to', to]] as const) {
    if (typeof value !== 'string' || !value.trim()) {
      return { ok: false, code: 'type', message: `sourceRange.${key} 必须是非空字符串` }
    }
    if (value.startsWith('ctx://')) {
      return {
        ok: false,
        code: 'archive-ref',
        message: `sourceRange.${key} 指向归档引用（ctx://）—— 这就是摘要的摘要`
      }
    }
  }
  const pair = { from: from as string, to: to as string }
  if (opts.knownEpisodeIds?.includes(pair.from) || opts.knownEpisodeIds?.includes(pair.to)) {
    return { ok: false, code: 'episode-ref', message: 'sourceRange 指向另一份 EpisodeState —— 禁止递归摘要' }
  }
  if (opts.knownEntryIds) {
    const i = opts.knownEntryIds.indexOf(pair.from)
    const j = opts.knownEntryIds.indexOf(pair.to)
    if (i < 0) return { ok: false, code: 'unknown-raw-entry', message: `原始会话里没有 from 条目：${pair.from}` }
    if (j < 0) return { ok: false, code: 'unknown-raw-entry', message: `原始会话里没有 to 条目：${pair.to}` }
    if (i > j) return { ok: false, code: 'range-order', message: 'sourceRange.from 在 to 之后（顺序反了）' }
  }
  return { ok: true, range: pair }
}

function validateSourceRange(raw: unknown, opts: RawIndex, path: string, issues: IssueSink): SourceRange | null {
  const res = checkSourceRange(raw, opts)
  if (!res.ok) {
    issues.add(path, res.code, res.message)
    return null
  }
  return res.range
}

/* ══════════════════════════════════════════════════════════════════
 * Task State 校验
 * ══════════════════════════════════════════════════════════════════ */

function validateStateEntry(raw: unknown, opts: RawIndex, path: string, issues: IssueSink): StateEntry | null {
  if (!isRec(raw)) {
    issues.add(path, 'type', '状态条目必须是对象')
    return null
  }
  let bad = false
  if (!isNonEmptyString(raw.text)) {
    issues.add(`${path}.text`, 'missing', 'text 不能为空')
    bad = true
  }
  const statuses: StateEntryStatus[] = ['active', 'resolved', 'superseded']
  if (typeof raw.status !== 'string' || !statuses.includes(raw.status as StateEntryStatus)) {
    issues.add(`${path}.status`, 'bad-status', `status 必须是 ${statuses.join(' / ')}`)
    bad = true
  }
  if (!isTimestamp(raw.updatedAt)) {
    issues.add(`${path}.updatedAt`, 'type', 'updatedAt 必须是毫秒时间戳')
    bad = true
  }
  const source = validateProvenance(raw.source, opts, `${path}.source`, issues)
  if (!source) bad = true

  const superseded = raw.status === 'superseded'
  if (superseded && !isNonEmptyString(raw.supersededBy)) {
    issues.add(`${path}.supersededBy`, 'superseded-by', 'superseded 条目必须写明被哪条取代')
    bad = true
  }
  if (!superseded && raw.supersededBy !== undefined) {
    issues.add(`${path}.supersededBy`, 'superseded-by', '只有 superseded 条目可以带 supersededBy')
    bad = true
  }
  if (bad) return null
  return {
    text: raw.text as string,
    status: raw.status as StateEntryStatus,
    source: source as StateProvenance,
    updatedAt: raw.updatedAt as number,
    ...(raw.supersededBy !== undefined ? { supersededBy: raw.supersededBy as string } : {})
  }
}

function validateEntryList(raw: unknown, opts: RawIndex, path: string, issues: IssueSink): StateEntry[] | null {
  if (!Array.isArray(raw)) {
    issues.add(path, 'type', '必须是数组')
    return null
  }
  const out: StateEntry[] = []
  let bad = false
  raw.forEach((item, i) => {
    const entry = validateStateEntry(item, opts, `${path}[${i}]`, issues)
    if (!entry) bad = true
    else out.push(entry)
  })
  return bad ? null : out
}

function validateStringList(
  raw: unknown,
  path: string,
  issues: IssueSink,
  validate: (value: string, at: string) => boolean
): string[] | null {
  if (!Array.isArray(raw)) {
    issues.add(path, 'type', '必须是数组')
    return null
  }
  const out: string[] = []
  let bad = false
  raw.forEach((item, i) => {
    const at = `${path}[${i}]`
    if (!isNonEmptyString(item)) {
      issues.add(at, 'empty', '不能为空')
      bad = true
      return
    }
    if (!validate(item, at)) bad = true
    else out.push(item)
  })
  return bad ? null : out
}

/**
 * Task State 校验。
 *
 * 给了 `knownEntryIds` 时，每条 provenance 的 `entryId` 必须在原始会话里
 * 真的存在 —— 这是「provenance 只能指向 raw entry identity」的执法点。
 * 没给时只做形状校验（调用方拿不到原始条目索引的场合）。
 */
export function validateTaskState(raw: unknown, opts: RawIndex = {}): ValidationResult<TaskState> {
  const issues = new Issues()
  if (!isRec(raw)) {
    issues.add('task', 'not-object', 'task 必须是对象')
    return { ok: false, issues: issues.list }
  }

  let task: { objective: string; currentPhase: string } | null = null
  if (!isRec(raw.task)) {
    issues.add('task.task', 'type', 'task.task 必须是对象')
  } else {
    const objective = raw.task.objective
    const currentPhase = raw.task.currentPhase
    if (!isNonEmptyString(objective)) issues.add('task.task.objective', 'missing', 'objective 不能为空')
    if (!isNonEmptyString(currentPhase)) issues.add('task.task.currentPhase', 'missing', 'currentPhase 不能为空')
    if (isNonEmptyString(objective) && isNonEmptyString(currentPhase)) task = { objective, currentPhase }
  }

  const lists: Array<keyof TaskState> = [
    'currentState',
    'decisions',
    'constraints',
    'completed',
    'failedAttempts',
    'unresolved',
    'nextActions',
    'assumptions',
    'hypothesis'
  ]
  const parsedLists = new Map<string, StateEntry[]>()
  for (const key of lists) {
    const parsed = validateEntryList(raw[key], opts, `task.${key}`, issues)
    if (parsed) parsedLists.set(key, parsed)
  }

  const files: FileState[] = []
  if (!Array.isArray(raw.files)) {
    issues.add('task.files', 'type', '必须是数组')
  } else {
    raw.files.forEach((item, i) => {
      const at = `task.files[${i}]`
      if (!isRec(item) || !isNonEmptyString(item.path) || typeof item.state !== 'string') {
        issues.add(at, 'type', '文件状态需要 path 与 state')
        return
      }
      const source = validateProvenance(item.source, opts, `${at}.source`, issues)
      if (!source) return
      files.push({ path: item.path, state: item.state, source })
    })
  }

  const commandsRun: CommandRun[] = []
  if (!Array.isArray(raw.commandsRun)) {
    issues.add('task.commandsRun', 'type', '必须是数组')
  } else {
    raw.commandsRun.forEach((item, i) => {
      const at = `task.commandsRun[${i}]`
      if (!isRec(item) || !isNonEmptyString(item.command)) {
        issues.add(at, 'type', '命令记录需要 command')
        return
      }
      if (item.exitCode !== undefined && !Number.isInteger(item.exitCode)) {
        issues.add(`${at}.exitCode`, 'type', 'exitCode 必须是整数')
        return
      }
      const source = validateProvenance(item.source, opts, `${at}.source`, issues)
      if (!source) return
      commandsRun.push({
        command: item.command,
        source,
        ...(item.exitCode !== undefined ? { exitCode: item.exitCode as number } : {})
      })
    })
  }

  const testsRun: TestRun[] = []
  if (!Array.isArray(raw.testsRun)) {
    issues.add('task.testsRun', 'type', '必须是数组')
  } else {
    raw.testsRun.forEach((item, i) => {
      const at = `task.testsRun[${i}]`
      if (!isRec(item) || !isNonEmptyString(item.command)) {
        issues.add(at, 'type', '测试记录需要 command')
        return
      }
      for (const key of ['passed', 'failed'] as const) {
        if (item[key] !== undefined && !isCount(item[key])) {
          issues.add(`${at}.${key}`, 'type', `${key} 必须是非负整数`)
          return
        }
      }
      const source = validateProvenance(item.source, opts, `${at}.source`, issues)
      if (!source) return
      testsRun.push({
        command: item.command,
        source,
        ...(item.passed !== undefined ? { passed: item.passed as number } : {}),
        ...(item.failed !== undefined ? { failed: item.failed as number } : {})
      })
    })
  }

  const symbolsTouched: SymbolTouch[] = []
  if (!Array.isArray(raw.symbolsTouched)) {
    issues.add('task.symbolsTouched', 'type', '必须是数组')
  } else {
    raw.symbolsTouched.forEach((item, i) => {
      const at = `task.symbolsTouched[${i}]`
      if (!isRec(item) || !isNonEmptyString(item.symbol)) {
        issues.add(at, 'type', '符号记录需要 symbol')
        return
      }
      if (item.path !== undefined && !isNonEmptyString(item.path)) {
        issues.add(`${at}.path`, 'type', 'path 必须是非空字符串')
        return
      }
      const source = validateProvenance(item.source, opts, `${at}.source`, issues)
      if (!source) return
      symbolsTouched.push({
        symbol: item.symbol,
        source,
        ...(item.path !== undefined ? { path: item.path as string } : {})
      })
    })
  }

  const episodeRefs = validateStringList(raw.episodeRefs, 'task.episodeRefs', issues, (value, at) => {
    if (opts.knownEpisodeIds && !opts.knownEpisodeIds.includes(value)) {
      issues.add(at, 'unknown-episode', `没有这份 EpisodeState：${value}`)
      return false
    }
    if (value.startsWith('ctx://')) {
      issues.add(at, 'bad-ref', 'episodeRefs 应当是 EpisodeState id，不是 ctx:// 归档引用')
      return false
    }
    return true
  })
  const archiveRefs = validateStringList(raw.archiveRefs, 'task.archiveRefs', issues, (value, at) => {
    return validateCtxRef(value, null, at, issues) !== null
  })

  if (issues.list.length) return { ok: false, issues: issues.list }

  return {
    ok: true,
    value: {
      task: task as { objective: string; currentPhase: string },
      currentState: parsedLists.get('currentState') ?? [],
      decisions: parsedLists.get('decisions') ?? [],
      constraints: parsedLists.get('constraints') ?? [],
      files,
      completed: parsedLists.get('completed') ?? [],
      failedAttempts: parsedLists.get('failedAttempts') ?? [],
      unresolved: parsedLists.get('unresolved') ?? [],
      nextActions: parsedLists.get('nextActions') ?? [],
      commandsRun,
      testsRun,
      symbolsTouched,
      assumptions: parsedLists.get('assumptions') ?? [],
      hypothesis: parsedLists.get('hypothesis') ?? [],
      episodeRefs: episodeRefs ?? [],
      archiveRefs: archiveRefs ?? []
    }
  }
}

/* ══════════════════════════════════════════════════════════════════
 * Episode State 校验
 * ══════════════════════════════════════════════════════════════════ */

export function validateEpisodeState(raw: unknown, opts: RawIndex = {}): ValidationResult<EpisodeState> {
  const issues = new Issues()
  if (!isRec(raw)) {
    issues.add('episode', 'not-object', 'episode 必须是对象')
    return { ok: false, issues: issues.list }
  }
  if (!isNonEmptyString(raw.id)) issues.add('episode.id', 'missing', 'id 不能为空')
  if (!isNonEmptyString(raw.objective)) issues.add('episode.objective', 'missing', 'objective 不能为空')
  if (typeof raw.outcome !== 'string') issues.add('episode.outcome', 'type', 'outcome 必须是字符串（可以为空）')
  if (!isTimestamp(raw.createdAt)) issues.add('episode.createdAt', 'type', 'createdAt 必须是毫秒时间戳')
  if (!isCount(raw.tokensBefore)) issues.add('episode.tokensBefore', 'type', 'tokensBefore 必须是非负整数')
  const watermark = validateWatermark(raw.watermark, 'episode.watermark', issues)
  const sourceRange = validateSourceRange(raw.sourceRange, opts, 'episode.sourceRange', issues)

  const decisions: EpisodeDecision[] = []
  if (!Array.isArray(raw.decisions)) {
    issues.add('episode.decisions', 'type', '必须是数组')
  } else {
    raw.decisions.forEach((item, i) => {
      const at = `episode.decisions[${i}]`
      if (!isRec(item) || !isNonEmptyString(item.decision)) {
        issues.add(at, 'type', '决定需要 decision 文本')
        return
      }
      if (item.reason !== undefined && typeof item.reason !== 'string') {
        issues.add(`${at}.reason`, 'type', 'reason 必须是字符串')
        return
      }
      decisions.push({ decision: item.decision, ...(item.reason !== undefined ? { reason: item.reason as string } : {}) })
    })
  }

  const filesChanged: EpisodeFileChange[] = []
  if (!Array.isArray(raw.filesChanged)) {
    issues.add('episode.filesChanged', 'type', '必须是数组')
  } else {
    raw.filesChanged.forEach((item, i) => {
      const at = `episode.filesChanged[${i}]`
      if (!isRec(item) || !isNonEmptyString(item.path)) {
        issues.add(at, 'type', '文件改动需要 path')
        return
      }
      if (item.summary !== undefined && typeof item.summary !== 'string') {
        issues.add(`${at}.summary`, 'type', 'summary 必须是字符串')
        return
      }
      filesChanged.push({
        path: item.path,
        ...(item.summary !== undefined ? { summary: item.summary as string } : {})
      })
    })
  }

  const constraints = validateStringList(raw.constraints, 'episode.constraints', issues, () => true)
  const failedAttempts = validateStringList(raw.failedAttempts, 'episode.failedAttempts', issues, () => true)
  const unresolved = validateStringList(raw.unresolved, 'episode.unresolved', issues, () => true)
  const importantRefs = validateStringList(raw.importantRefs, 'episode.importantRefs', issues, (value, at) => {
    return validateCtxRef(value, null, at, issues) !== null
  })

  if (issues.list.length) return { ok: false, issues: issues.list }
  return {
    ok: true,
    value: {
      id: raw.id as string,
      objective: raw.objective as string,
      outcome: raw.outcome as string,
      decisions,
      constraints: constraints ?? [],
      filesChanged,
      failedAttempts: failedAttempts ?? [],
      unresolved: unresolved ?? [],
      importantRefs: importantRefs ?? [],
      sourceRange: sourceRange as SourceRange,
      watermark: watermark as SourceWatermark,
      tokensBefore: raw.tokensBefore as number,
      createdAt: raw.createdAt as number
    }
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 状态文件判定
 * ══════════════════════════════════════════════════════════════════ */

function readVersion(raw: Rec): number | null {
  const version = raw.schemaVersion
  return typeof version === 'number' && Number.isInteger(version) ? version : null
}

/**
 * 判定一份状态文件能不能用。
 *
 * 三态而不是 boolean：调用方要能区分「版本不认识」与「内容坏了」，
 * 两者都丢弃，但日志/诊断里原因不同。**任何**非 ok 的返回值都必须
 * 导致丢弃，绝不能把半份状态喂给模型。
 */
export function inspectContextStateFile(raw: unknown, opts: RawIndex = {}): ContextStateInspection {
  if (!isRec(raw)) {
    return { status: 'invalid', issues: [{ path: '', code: 'not-object', message: '状态文件必须是对象' }] }
  }
  const version = readVersion(raw)
  if (version === null) {
    return {
      status: 'invalid',
      issues: [{ path: 'schemaVersion', code: 'missing', message: 'schemaVersion 必须是整数' }]
    }
  }
  if (version !== CONTEXT_STATE_SCHEMA_VERSION) {
    return {
      status: 'incompatible',
      foundVersion: version,
      issues: [
        {
          path: 'schemaVersion',
          code: 'unknown-version',
          message: `状态文件版本 ${version} 与当前 ${CONTEXT_STATE_SCHEMA_VERSION} 不兼容`
        }
      ]
    }
  }

  const issues = new Issues()
  if (!isNonEmptyString(raw.sessionId)) {
    issues.add('sessionId', 'missing', 'sessionId 不能为空')
  }
  const watermark = validateWatermark(raw.sourceWatermark, 'sourceWatermark', issues)
  if (raw.revision !== undefined) {
    if (typeof raw.revision !== 'number' || !Number.isInteger(raw.revision) || raw.revision < 0) {
      issues.add('revision', 'type', 'revision 必须是 ≥ 0 的整数')
    }
  }
  if (!isTimestamp(raw.createdAt)) issues.add('createdAt', 'type', 'createdAt 必须是毫秒时间戳')
  if (!isTimestamp(raw.updatedAt)) issues.add('updatedAt', 'type', 'updatedAt 必须是毫秒时间戳')

  const episodes: EpisodeState[] = []
  if (!Array.isArray(raw.episodes)) {
    issues.add('episodes', 'type', 'episodes 必须是数组')
  } else {
    const seen = new Set<string>()
    /*
     * 先扫一遍拿到**全部** episode id，再逐条校验。
     *
     * 为什么不能边校验边收集：§12.7 的判据是「sourceRange 不得指向另一份
     * EpisodeState」。如果只把**前面已解析**的 id 传进去，一份 Episode 指向
     * 它后面那份 Episode 就会被放过 —— 而「摘要的摘要」不会因为方向不同就变安全。
     * 这也修掉了 S1 的一个真实缺口：整份状态文件校验时曾经根本没传
     * `knownEpisodeIds`，于是只有单测显式传参的那条路才拦得住。
     */
    const episodeIds = raw.episodes
      .map((item) => (isRec(item) && isNonEmptyString(item.id) ? (item.id as string) : null))
      .filter((id): id is string => id !== null)
    const episodeOpts: RawIndex = { ...opts, knownEpisodeIds: episodeIds }
    raw.episodes.forEach((item, i) => {
      const at = `episodes[${i}]`
      const parsed = validateEpisodeState(item, episodeOpts)
      if (!parsed.ok) {
        issues.list.push(...parsed.issues.map((issue) => ({ ...issue, path: `${at}.${issue.path.replace(/^episode\.?/, '')}` })))
        return
      }
      if (seen.has(parsed.value.id)) {
        issues.add(`${at}.id`, 'type', `EpisodeState id 重复：${parsed.value.id}`)
        return
      }
      seen.add(parsed.value.id)
      episodes.push(parsed.value)
    })
  }

  const episodeIds = episodes.map((e) => e.id)
  const task = validateTaskState(raw.task, { ...opts, knownEpisodeIds: episodeIds })
  if (!task.ok) issues.list.push(...task.issues)

  if (issues.list.length) return { status: 'invalid', issues: issues.list }
  return {
    status: 'ok',
    state: {
      schemaVersion: version,
      sessionId: raw.sessionId as string,
      ...(typeof raw.revision === 'number' ? { revision: raw.revision } : {}),
      sourceWatermark: watermark as SourceWatermark,
      createdAt: raw.createdAt as number,
      updatedAt: raw.updatedAt as number,
      task: (task as { ok: true; value: TaskState }).value,
      episodes
    }
  }
}

/* ══════════════════════════════════════════════════════════════════
 * Archive 判定
 * ══════════════════════════════════════════════════════════════════ */

export function validateArchiveEntry(raw: unknown, opts: RawIndex = {}): ValidationResult<ArchiveEntry> {
  const issues = new Issues()
  if (!isRec(raw)) {
    issues.add('entry', 'not-object', '归档条目必须是对象')
    return { ok: false, issues: issues.list }
  }
  const kinds: ArchiveEntryKind[] = ['tool', 'episode', 'file', 'diff']
  const kind = raw.kind
  if (typeof kind !== 'string' || !kinds.includes(kind as ArchiveEntryKind)) {
    issues.add('entry.kind', 'type', `kind 必须是 ${kinds.join(' / ')}`)
  }
  if (!isNonEmptyString(raw.label)) issues.add('entry.label', 'missing', 'label 不能为空')
  if (!isTimestamp(raw.createdAt)) issues.add('entry.createdAt', 'type', 'createdAt 必须是毫秒时间戳')
  if (raw.expiresAt !== undefined && !isTimestamp(raw.expiresAt)) {
    issues.add('entry.expiresAt', 'type', 'expiresAt 必须是毫秒时间戳')
  }
  if (!isCount(raw.tokens)) issues.add('entry.tokens', 'type', 'tokens 必须是非负整数')
  const recallables: ArchiveRecallable[] = ['none', 'manual', 'agent']
  if (typeof raw.recallable !== 'string' || !recallables.includes(raw.recallable as ArchiveRecallable)) {
    issues.add('entry.recallable', 'type', `recallable 必须是 ${recallables.join(' / ')}`)
  }
  if (typeof raw.contentStored !== 'boolean') {
    issues.add('entry.contentStored', 'type', 'contentStored 必须是布尔值')
  }
  const ref = validateCtxRef(raw.ref, (kind as ArchiveEntryKind) ?? null, 'entry.ref', issues)
  const sourceRange = validateSourceRange(raw.sourceRange, opts, 'entry.sourceRange', issues)
  const watermark = validateWatermark(raw.watermark, 'entry.watermark', issues)

  if (issues.list.length) return { ok: false, issues: issues.list }
  return {
    ok: true,
    value: {
      ref: ref as string,
      kind: kind as ArchiveEntryKind,
      label: raw.label as string,
      createdAt: raw.createdAt as number,
      ...(raw.expiresAt !== undefined ? { expiresAt: raw.expiresAt as number } : {}),
      tokens: raw.tokens as number,
      recallable: raw.recallable as ArchiveRecallable,
      sourceRange: sourceRange as SourceRange,
      watermark: watermark as SourceWatermark,
      contentStored: raw.contentStored as boolean
    }
  }
}

export function inspectArchiveFile(raw: unknown, opts: RawIndex = {}): ArchiveInspection {
  if (!isRec(raw)) {
    return { status: 'invalid', issues: [{ path: '', code: 'not-object', message: '归档文件必须是对象' }] }
  }
  const version = readVersion(raw)
  if (version === null) {
    return {
      status: 'invalid',
      issues: [{ path: 'schemaVersion', code: 'missing', message: 'schemaVersion 必须是整数' }]
    }
  }
  if (version !== CONTEXT_ARCHIVE_SCHEMA_VERSION) {
    return {
      status: 'incompatible',
      foundVersion: version,
      issues: [
        {
          path: 'schemaVersion',
          code: 'unknown-version',
          message: `归档文件版本 ${version} 与当前 ${CONTEXT_ARCHIVE_SCHEMA_VERSION} 不兼容`
        }
      ]
    }
  }

  const issues = new Issues()
  if (!isNonEmptyString(raw.sessionId)) issues.add('sessionId', 'missing', 'sessionId 不能为空')
  if (!isTimestamp(raw.updatedAt)) issues.add('updatedAt', 'type', 'updatedAt 必须是毫秒时间戳')
  const entries: ArchiveEntry[] = []
  if (!Array.isArray(raw.entries)) {
    issues.add('entries', 'type', 'entries 必须是数组')
  } else {
    const seen = new Set<string>()
    raw.entries.forEach((item, i) => {
      const at = `entries[${i}]`
      const parsed = validateArchiveEntry(item, opts)
      if (!parsed.ok) {
        issues.list.push(...parsed.issues.map((issue) => ({ ...issue, path: `${at}.${issue.path.replace(/^entry\.?/, '')}` })))
        return
      }
      if (seen.has(parsed.value.ref)) {
        issues.add(`${at}.ref`, 'type', `ref 重复：${parsed.value.ref}`)
        return
      }
      seen.add(parsed.value.ref)
      entries.push(parsed.value)
    })
  }

  if (issues.list.length) return { status: 'invalid', issues: issues.list }
  return {
    status: 'ok',
    archive: {
      schemaVersion: version,
      sessionId: raw.sessionId as string,
      updatedAt: raw.updatedAt as number,
      entries
    }
  }
}

/* ══════════════════════════════════════════════════════════════════
 * Deep Context：只预留「能不能注入」的判据
 * ══════════════════════════════════════════════════════════════════ */

/**
 * Deep Context artifact 是否还能注入。
 *
 * ⚠️ 本函数**不产生任何模型调用**，也**不改**任何消息；它是后续切片
 * （N21-8）在真正注入前必须过的那道闸。四道检查缺一不可：
 *   ① 形状完整（绑定字段都在）；
 *   ② sessionId 与当前会话一致（不能把 A 会话的 trace 注入 B）；
 *   ③ 水位与当前 raw **完全一致**（不是 `older` —— trace 描述的必须是
 *      当前这份历史，否则模型会拿着过期世界模型推理）；
 *   ④ 未过期、且确实已经生成。
 */
export function deepContextUsable(
  artifact: unknown,
  ctx: DeepContextCheck
): { ok: true; artifact: DeepContextArtifact } | { ok: false; reason: DeepContextRejectReason } {
  if (!isRec(artifact)) return { ok: false, reason: 'not-object' }

  const { sessionId, sourceWatermark, createdAt, expiresAt, content } = artifact
  if (
    !isNonEmptyString(sessionId) ||
    !isTimestamp(createdAt) ||
    !isTimestamp(expiresAt) ||
    typeof content !== 'string'
  ) {
    return { ok: false, reason: 'missing-field' }
  }
  const wm = validateWatermark(sourceWatermark, 'sourceWatermark', { add() {} })
  if (!wm) return { ok: false, reason: 'invalid-watermark' }

  if (sessionId !== ctx.sessionId) return { ok: false, reason: 'session-mismatch' }
  if (watermarkRelation(wm, ctx.watermark) !== 'same') return { ok: false, reason: 'watermark-mismatch' }
  if (createdAt > ctx.now) return { ok: false, reason: 'not-created-yet' }
  if (expiresAt <= ctx.now) return { ok: false, reason: 'expired' }
  if (!content.trim()) return { ok: false, reason: 'empty-content' }

  return { ok: true, artifact: { sessionId, sourceWatermark: wm, createdAt, expiresAt, content } }
}

/* ══════════════════════════════════════════════════════════════════
 * 便利构造（让调用方不必手写容易写错的部分）
 * ══════════════════════════════════════════════════════════════════ */

/** 空 Task State —— 新会话第一次落状态时的起点，字段齐全但没有任何结论 */
export function emptyTaskState(objective: string, currentPhase: string): TaskState {
  return {
    task: { objective, currentPhase },
    currentState: [],
    decisions: [],
    constraints: [],
    files: [],
    completed: [],
    failedAttempts: [],
    unresolved: [],
    nextActions: [],
    commandsRun: [],
    testsRun: [],
    symbolsTouched: [],
    assumptions: [],
    hypothesis: [],
    episodeRefs: [],
    archiveRefs: []
  }
}


export function emptyArchiveFile(sessionId: string, now: number): ArchiveFile {
  return { schemaVersion: CONTEXT_ARCHIVE_SCHEMA_VERSION, sessionId, updatedAt: now, entries: [] }
}
