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

export const CONTEXT_STATE_SCHEMA_VERSION = 1
export const CONTEXT_ARCHIVE_SCHEMA_VERSION = 1

export type RawEntryId = string

export interface SourceWatermark {
  entryCount: number
  lastEntryId: RawEntryId | null
}

export type WatermarkRelation =
  | 'same'
  | 'older'
  | 'diverged'
  | 'unknown'

export interface SourceRange {
  from: RawEntryId
  to: RawEntryId
}

export type StateSourceKind = 'user' | 'tool' | 'file' | 'model'

export type StateConfidence = 'observed' | 'derived' | 'hypothesis'

export interface StateProvenance {
  kind: StateSourceKind
  entryId?: RawEntryId
  path?: string
  confidence: StateConfidence
}

export type StateEntryStatus = 'active' | 'resolved' | 'superseded'

export interface StateEntry {
  text: string
  status: StateEntryStatus
  source: StateProvenance
  updatedAt: number
  supersededBy?: string
}

export interface FileState {
  path: string
  state: string
  source: StateProvenance
}

export interface CommandRun {
  command: string
  exitCode?: number
  source: StateProvenance
}

export interface TestRun {
  command: string
  passed?: number
  failed?: number
  source: StateProvenance
}

export interface SymbolTouch {
  symbol: string
  path?: string
  source: StateProvenance
}

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
  episodeRefs: string[]
  archiveRefs: string[]
}

export type CodingState = TaskState

export interface EpisodeDecision {
  decision: string
  reason?: string
}

export interface EpisodeFileChange {
  path: string
  summary?: string
}

export interface EpisodeState {
  id: string
  objective: string
  outcome: string
  decisions: EpisodeDecision[]
  constraints: string[]
  filesChanged: EpisodeFileChange[]
  failedAttempts: string[]
  unresolved: string[]
  importantRefs: string[]
  sourceRange: SourceRange
  watermark: SourceWatermark
  tokensBefore: number
  createdAt: number
}

export interface ContextStateFile {
  schemaVersion: number
  sessionId: string
  revision?: number
  sourceWatermark: SourceWatermark
  createdAt: number
  updatedAt: number
  task: TaskState
  episodes: EpisodeState[]
}

export interface ValidationIssue {
  path: string
  code: ValidationCode
  message: string
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: ValidationIssue[] }

export type ContextStateInspection =
  | { status: 'ok'; state: ContextStateFile }
  | { status: 'incompatible'; foundVersion: number; issues: ValidationIssue[] }
  | { status: 'invalid'; issues: ValidationIssue[] }

export type ArchiveEntryKind = 'tool' | 'episode' | 'file' | 'diff'

export type ArchiveRecallable = 'none' | 'manual' | 'agent'

export interface ArchiveEntry {
  ref: string
  kind: ArchiveEntryKind
  label: string
  createdAt: number
  expiresAt?: number
  tokens: number
  recallable: ArchiveRecallable
  sourceRange: SourceRange
  watermark: SourceWatermark
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

export interface DeepContextArtifact {
  sessionId: string
  sourceWatermark: SourceWatermark
  createdAt: number
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

export function isRawEntryIdShape(v: unknown): v is RawEntryId {
  if (typeof v !== 'string') return false
  const id = v.trim()
  if (!id) return false
  if (id.startsWith('ctx://')) return false
  return true
}

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

export function watermarkRelation(state: SourceWatermark, current: SourceWatermark): WatermarkRelation {
  if (!isCount(state?.entryCount) || !isCount(current?.entryCount)) return 'unknown'
  const sameTail = state.lastEntryId === current.lastEntryId
  if (state.entryCount === current.entryCount) return sameTail ? 'same' : 'diverged'
  if (state.entryCount < current.entryCount) return 'older'
  return 'diverged'
}

export function watermarksEqual(a: SourceWatermark, b: SourceWatermark): boolean {
  return a.entryCount === b.entryCount && a.lastEntryId === b.lastEntryId
}

export interface RawIndex {
  knownEntryIds?: readonly RawEntryId[]
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

function readVersion(raw: Rec): number | null {
  const version = raw.schemaVersion
  return typeof version === 'number' && Number.isInteger(version) ? version : null
}

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
