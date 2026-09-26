/**
 * 学习记忆：笔记与概念进度（LearningNote / ConceptProgress）—— 契约与纯逻辑（实施-25 P11）。
 *
 * ══════════════════════════════════════════════════════════
 * 它守的是什么（R7 落点）
 * ══════════════════════════════════════════════════════════
 * 学习进度最容易做错的地方，是把它压成一个互斥状态机：
 * 「未接触 → 提示下完成 → 独立完成 → 新情境应用」像一条单行道，
 * 于是「已独立完成」和「该复习了」不能同时成立。真实情况恰恰相反 ——
 * 一个人可以**上周独立做对过、这周忘了**。
 *
 * 所以这里把它拆成**两条轴**：
 *   · **观察层级**（能力证据）：unseen → with-hint → independent → transfer；
 *   · **复习状态**（独立字段）：`review` 是 / 否。
 * 两者分别计算、分别保存，可以同时为真（T11-2）。
 *
 * 另外三条不能违背的规则：
 *   ① **`Attempt` 是事实源**（T11-3）：这里的 `ConceptProgress` 只是它的稳定摘要，
 *      所以证据（哪道题、哪次作答、用了多少帮助）要留在记录里，能回看；
 *   ② **升级要证据，降级不被单次噪声驱动**（T11-4）：层级单调不减，
 *      一次失败**不降级**、只把 `review` 置为真；两次不同练习的独立成功才稳定进
 *      「独立完成」；「新情境应用」只能来自真正的应用题（`transfer` 标记）；
 *   ③ **用户自评与系统观察并存**（T11-5）：`selfAssessment` 是另一个字段，
 *      用户说「我已经会了」不会把系统的 `level` 改掉，反之亦然。
 *
 * 边界：不做复习调度（P12 的 `ReviewItem`）、不做错题本；本片只保证
 * 「记录是真的、两条轴没有互相覆盖」。
 */

import type { CourseSourceRef } from './course'
import type { Attempt, Exercise, HintLevel } from './exercise'
import { MAX_REVIEWS, sanitizeReview, type ReviewItem } from './review'

/** 观察层级（能力证据）。顺序即强弱，数组顺序也用于「只升不降」。 */
export const OBSERVATION_LEVELS = ['unseen', 'with-hint', 'independent', 'transfer'] as const
export type ObservationLevel = (typeof OBSERVATION_LEVELS)[number]

export const OBSERVATION_LABELS: Record<ObservationLevel, string> = {
  unseen: '未接触',
  'with-hint': '在提示下完成',
  independent: '独立完成',
  transfer: '能应用到新情境'
}

export function observationLabel(level: ObservationLevel): string {
  return OBSERVATION_LABELS[level] ?? level
}

/** 用户自评：与系统观察并存，互不覆盖。 */
export type SelfAssessmentKind = 'got-it' | 'suspect'

export interface SelfAssessment {
  kind: SelfAssessmentKind
  text?: string
  at: number
}

export const SELF_ASSESSMENT_LABELS: Record<SelfAssessmentKind, string> = {
  'got-it': '我已经会了',
  suspect: '我还不确定'
}

export const NOTE_KINDS = ['note', 'summary'] as const
export type NoteKind = (typeof NOTE_KINDS)[number]

export const NOTE_KIND_LABELS: Record<NoteKind, string> = {
  note: '笔记',
  summary: '整理稿'
}

/** 一条概念进度的证据（是 `Attempt` 的摘要，不是它的副本）。 */
export interface ProgressEvidence {
  at: number
  exerciseId: string
  attemptId: string
  /** 这次作答的客观判定；`null` = 开放题（**不作为能力证据**，但会留下痕迹）。 */
  correct: boolean | null
  hintLevelSeen: HintLevel | 'none'
  lookedAtSolution: boolean
  /**
   * 这道题是不是「新情境」题（`kind === 'apply'`）。
   *
   * 它是**题目的性质**，不是这次作答的结论：只有与 {@link independent} 同时
   * 为真时，`summarizeProgress` 才把它算成「能在新情境中应用」的证据。
   */
  transfer: boolean
  /** 这一次是否算独立完成（与 `shared/exercise.ts` 的判据同源）。 */
  independent: boolean
}

export interface ConceptProgress {
  conceptId: string
  courseId: string
  /** 系统观察（单调不减）。 */
  level: ObservationLevel
  /** 复习状态：**独立于 `level`** 的一条轴。 */
  review: boolean
  evidence: ProgressEvidence[]
  /** 用户自评：与系统观察分别保存、并存（T11-5）。 */
  selfAssessment?: SelfAssessment
  updatedAt: number
}

export interface LearningNote {
  id: string
  courseId: string
  /** 关联单元（可选：有些笔记是整门课的）。 */
  unitId?: string
  conceptIds: string[]
  kind: NoteKind
  title?: string
  body: string
  /** 出处（指回资料库的真实版本）。 */
  sources: CourseSourceRef[]
  createdAt: number
  updatedAt: number
}

export interface LearningMemoryDocument {
  version: 1
  notes: LearningNote[]
  progress: ConceptProgress[]
  /** 错题与复习（P12）：与笔记 / 进度同一份文档，因为它们按同一门课程组织。 */
  reviews: ReviewItem[]
}

export const MAX_NOTES = 2000
export const MAX_NOTE_BODY = 20000
export const MAX_NOTE_TITLE = 120
export const MAX_EVIDENCE_PER_CONCEPT = 50
export const MAX_SELF_ASSESSMENT_CHARS = 500
export const MAX_CONCEPTS_PER_NOTE = 20

export type NoteMutation = { ok: true; note: LearningNote; unchanged?: boolean } | { ok: false; reason: string }

/* ------------------------------------------------------------------ *
 * 观察层级的比较（只升不降）
 * ------------------------------------------------------------------ */

export function levelRank(level: ObservationLevel): number {
  return OBSERVATION_LEVELS.indexOf(level)
}

/** 取更强的那个（层级单调不减）。未知值当 `unseen`。 */
export function strongerLevel(a: ObservationLevel, b: ObservationLevel): ObservationLevel {
  return levelRank(a) >= levelRank(b) ? a : b
}

/* ------------------------------------------------------------------ *
 * 从证据算进度（T11-3 / T11-4）
 * ------------------------------------------------------------------ */

/** 至少两次**不同练习**的独立成功，才稳定进入「独立完成」。 */
export const INDEPENDENT_EXERCISES_REQUIRED = 2

/** 连续的独立成功达到这个数，就把「建议复习」收掉。 */
export const REVIEW_CLEAR_STREAK = 2

/**
 * 把一道题 + 一次作答折成一条证据。
 *
 * `independent` 与 `shared/exercise.ts` 的 `isIndependent` 同义 —— 这里重算一遍
 * 而不是从别处读，是因为证据要能独立解释自己（换版本后回看旧证据也讲得通）。
 */
export function evidenceFromAttempt(exercise: Pick<Exercise, 'id' | 'kind'>, attempt: Attempt): ProgressEvidence {
  const independent =
    attempt.correct === true && attempt.hintLevelSeen === 'none' && attempt.lookedAtSolution !== true
  return {
    at: attempt.at,
    exerciseId: exercise.id,
    attemptId: attempt.id,
    correct: attempt.correct,
    hintLevelSeen: attempt.hintLevelSeen,
    lookedAtSolution: attempt.lookedAtSolution === true,
    transfer: exercise.kind === 'apply',
    independent
  }
}

export interface ProgressSummary {
  level: ObservationLevel
  review: boolean
  /** 独立成功过的**不同**练习数（界面用来解释「为什么还差一次」）。 */
  independentExercises: number
  /** 新情境下独立成功过的不同练习数。 */
  transferExercises: number
  /** 提示下（或看过解释后）做对的次数。 */
  assistedSuccesses: number
  /** 明确答错的次数。 */
  failures: number
}

/**
 * 汇总证据 → 两条轴。
 *
 * **有意不做降级**：`level` 只会取 `existing` 与本次计算的更强值。
 * 设计里「持续出现证据后再重新评估」目前只落在 `review` 上（失败即标记），
 * 层级降级留待后续片 —— 少做一步比做一个靠单次噪声跳动的状态机安全。
 */
export function summarizeProgress(input: {
  evidence: readonly ProgressEvidence[]
  existing?: ConceptProgress | null
}): ProgressSummary {
  const evidence = [...input.evidence].sort((a, b) => a.at - b.at)
  const independentSet = new Set<string>()
  const transferSet = new Set<string>()
  let assistedSuccesses = 0
  let failures = 0

  for (const item of evidence) {
    if (item.correct === false) {
      failures += 1
      continue
    }
    if (item.correct !== true) continue
    if (item.independent) {
      independentSet.add(item.exerciseId)
      if (item.transfer) transferSet.add(item.exerciseId)
    } else {
      /* 用了提示 / 看过解释也算「完成过」，只是不算独立。 */
      assistedSuccesses += 1
    }
  }

  /* 观察层级：先按证据算，再与既有值取更强（只升不降）。 */
  let computed: ObservationLevel = 'unseen'
  if (transferSet.size >= 1) computed = 'transfer'
  else if (independentSet.size >= INDEPENDENT_EXERCISES_REQUIRED) computed = 'independent'
  else if (independentSet.size >= 1 || assistedSuccesses >= 1) computed = 'with-hint'
  const level = strongerLevel(input.existing?.level ?? 'unseen', computed)

  /* 复习轴：出现失败 / 看过解释即标记；连续独立成功则收掉。 */
  const lastTwo = evidence.slice(-REVIEW_CLEAR_STREAK)
  const solidStreak =
    lastTwo.length >= REVIEW_CLEAR_STREAK && lastTwo.every((item) => item.independent)
  const hasFailure = evidence.some((item) => item.correct === false)

  let review: boolean
  const latest = evidence[evidence.length - 1]
  if (!latest) {
    review = input.existing?.review === true
  } else if (latest.correct === false) {
    review = true
  } else if (solidStreak && !hasFailure) {
    review = false
  } else if (solidStreak) {
    /* 最近的两次是独立成功，但历史上出过错：保持既有复习建议（不因两次成功就洗掉）。 */
    review = input.existing?.review === true
  } else {
    /*
     * 用了提示或看过解释：即使做对了也建议再看一次（T10-2 的同一条边界）。
     * “看过解释” 尤其不能算掌掽。
     */
    const needsReview = latest.lookedAtSolution === true || latest.hintLevelSeen !== 'none'
    review = input.existing?.review === true || needsReview
  }

  return { level, review, independentExercises: independentSet.size, transferExercises: transferSet.size, failures, assistedSuccesses }
}

/**
 * 用一段证据重算一条概念进度（保留自评与既有层级）。
 *
 * 纯函数：存储层与服务层都调它，所以「两条轴怎么变」只有这一处规则。
 */
export function applyProgress(
  conceptId: string,
  courseId: string,
  evidence: readonly ProgressEvidence[],
  existing: ConceptProgress | null,
  at: number
): ConceptProgress {
  const summary = summarizeProgress({ evidence, existing })
  const trimmed = [...evidence].sort((a, b) => a.at - b.at).slice(-MAX_EVIDENCE_PER_CONCEPT)
  return {
    conceptId,
    courseId,
    level: summary.level,
    review: summary.review,
    evidence: trimmed,
    ...(existing?.selfAssessment ? { selfAssessment: existing.selfAssessment } : {}),
    updatedAt: at
  }
}

/** 给界面的一段可读摘要（「为什么是这一档」）。 */
export function progressExplanation(progress: ConceptProgress): string {
  const summary = summarizeProgress({ evidence: progress.evidence, existing: progress })
  const parts: string[] = [observationLabel(progress.level)]
  if (progress.level !== 'transfer' && progress.level !== 'unseen') {
    parts.push(`独立成功 ${summary.independentExercises}/${INDEPENDENT_EXERCISES_REQUIRED} 次不同练习`)
  }
  if (progress.review) parts.push('建议复习')
  return parts.join(' · ')
}

/* ------------------------------------------------------------------ *
 * 容错读盘
 * ------------------------------------------------------------------ */

function clampText(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (!text) return null
  if (text.length > max) return null
  if (/[\u0000-\u001f\u007f]/.test(text)) return null
  return text
}

function sanitizeSources(raw: unknown): CourseSourceRef[] {
  if (!Array.isArray(raw)) return []
  const out: CourseSourceRef[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const sourceId = typeof o.sourceId === 'string' ? o.sourceId.trim() : ''
    const version = Number(o.version)
    if (!sourceId || !Number.isFinite(version) || version <= 0) continue
    const ref: CourseSourceRef = { sourceId, version: Math.round(version) }
    const locator = o.locator
    if (locator && typeof locator === 'object') {
      const l = locator as Record<string, unknown>
      const start = Number(l.start)
      const end = Number(l.end)
      if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end >= start) {
        ref.locator = { start: Math.round(start), end: Math.round(end) }
      }
    }
    out.push(ref)
  }
  return out.slice(0, 20)
}

export interface LearningNoteInput {
  courseId: string
  unitId?: string
  conceptIds?: string[]
  kind?: NoteKind
  title?: string
  body: string
  sources?: CourseSourceRef[]
}

export function validateNoteInput(raw: unknown): { ok: true; value: LearningNoteInput } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: '输入不是对象' }
  const o = raw as Record<string, unknown>
  const courseId = clampText(o.courseId, 80)
  if (!courseId) return { ok: false, reason: '缺少课程 id' }
  const body = clampText(o.body, MAX_NOTE_BODY)
  if (!body) return { ok: false, reason: `笔记内容不能为空，且最多 ${MAX_NOTE_BODY} 个字符` }
  const kind = (NOTE_KINDS as readonly string[]).includes(String(o.kind)) ? (o.kind as NoteKind) : 'note'
  const value: LearningNoteInput = { courseId, body, kind }
  const unitId = clampText(o.unitId, 80)
  if (unitId) value.unitId = unitId
  const title = clampText(o.title, MAX_NOTE_TITLE)
  if (title) value.title = title
  if (Array.isArray(o.conceptIds)) {
    value.conceptIds = o.conceptIds.filter((c): c is string => typeof c === 'string' && !!c.trim()).slice(0, MAX_CONCEPTS_PER_NOTE)
  }
  const sources = sanitizeSources(o.sources)
  if (sources.length) value.sources = sources
  return { ok: true, value }
}

export function makeNoteId(random: () => number = Math.random): string {
  return `nt_${Math.floor(random() * 36 ** 10).toString(36)}`
}

export function createNote(input: LearningNoteInput, at: number, id: string): LearningNote {
  return {
    id,
    courseId: input.courseId,
    ...(input.unitId ? { unitId: input.unitId } : {}),
    conceptIds: [...(input.conceptIds ?? [])],
    kind: input.kind ?? 'note',
    ...(input.title ? { title: input.title } : {}),
    body: input.body,
    sources: [...(input.sources ?? [])],
    createdAt: at,
    updatedAt: at
  }
}

export function updateNote(
  note: LearningNote,
  patch: { title?: unknown; body?: unknown; kind?: unknown; unitId?: unknown; conceptIds?: unknown },
  at: number
): NoteMutation {
  const next: LearningNote = { ...note }
  if (patch.body !== undefined) {
    const body = clampText(patch.body, MAX_NOTE_BODY)
    if (!body) return { ok: false, reason: `笔记内容不能为空，且最多 ${MAX_NOTE_BODY} 个字符` }
    next.body = body
  }
  if (patch.title !== undefined) {
    if (patch.title === null || patch.title === '') delete next.title
    else {
      const title = clampText(patch.title, MAX_NOTE_TITLE)
      if (!title) return { ok: false, reason: `标题最多 ${MAX_NOTE_TITLE} 个字符` }
      next.title = title
    }
  }
  if (patch.kind !== undefined) {
    if (!(NOTE_KINDS as readonly string[]).includes(String(patch.kind))) return { ok: false, reason: '未知的笔记类型' }
    next.kind = patch.kind as NoteKind
  }
  if (patch.unitId !== undefined) {
    if (patch.unitId === null || patch.unitId === '') delete next.unitId
    else {
      const unitId = clampText(patch.unitId, 80)
      if (!unitId) return { ok: false, reason: '单元 id 不合法' }
      next.unitId = unitId
    }
  }
  if (Array.isArray(patch.conceptIds)) {
    next.conceptIds = patch.conceptIds.filter((c): c is string => typeof c === 'string' && !!c.trim()).slice(0, MAX_CONCEPTS_PER_NOTE)
  }
  if (
    next.title === note.title &&
    next.body === note.body &&
    next.kind === note.kind &&
    next.unitId === note.unitId &&
    next.conceptIds.join(',') === note.conceptIds.join(',')
  ) {
    return { ok: true, note, unchanged: true }
  }
  next.updatedAt = at
  return { ok: true, note: next }
}

export function sanitizeNote(raw: unknown): LearningNote | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const checked = validateNoteInput({
    courseId: o.courseId,
    unitId: o.unitId,
    conceptIds: o.conceptIds,
    kind: o.kind,
    title: o.title,
    body: o.body,
    sources: o.sources
  })
  if (!checked.ok) return null
  const id = typeof o.id === 'string' ? o.id.trim() : ''
  if (!id) return null
  const v = checked.value
  const createdAt = Number.isFinite(Number(o.createdAt)) ? Number(o.createdAt) : 0
  return {
    id,
    courseId: v.courseId,
    ...(v.unitId ? { unitId: v.unitId } : {}),
    conceptIds: [...(v.conceptIds ?? [])],
    kind: v.kind ?? 'note',
    ...(v.title ? { title: v.title } : {}),
    body: v.body,
    sources: [...(v.sources ?? [])],
    createdAt,
    updatedAt: Number.isFinite(Number(o.updatedAt)) ? Number(o.updatedAt) : createdAt
  }
}

function sanitizeEvidence(raw: unknown): ProgressEvidence | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const exerciseId = typeof o.exerciseId === 'string' ? o.exerciseId.trim() : ''
  if (!exerciseId) return null
  const correct = typeof o.correct === 'boolean' ? o.correct : null
  const hintLevelSeen = (['direction', 'concept', 'next-step', 'example'] as readonly string[]).includes(String(o.hintLevelSeen))
    ? (o.hintLevelSeen as HintLevel)
    : 'none'
  const at = Number.isFinite(Number(o.at)) ? Number(o.at) : 0
  const independent =
    typeof o.independent === 'boolean'
      ? o.independent
      : correct === true && hintLevelSeen === 'none' && o.lookedAtSolution !== true
  return {
    at,
    exerciseId,
    attemptId: typeof o.attemptId === 'string' ? o.attemptId : '',
    correct,
    hintLevelSeen,
    lookedAtSolution: o.lookedAtSolution === true,
    transfer: o.transfer === true,
    independent
  }
}

export function sanitizeProgress(raw: unknown): ConceptProgress | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const conceptId = typeof o.conceptId === 'string' ? o.conceptId.trim() : ''
  const courseId = typeof o.courseId === 'string' ? o.courseId.trim() : ''
  if (!conceptId || !courseId) return null
  const rawLevel = (OBSERVATION_LEVELS as readonly string[]).includes(String(o.level)) ? (o.level as ObservationLevel) : 'unseen'
  const evidence = Array.isArray(o.evidence)
    ? o.evidence.map(sanitizeEvidence).filter((e): e is ProgressEvidence => e !== null).slice(-MAX_EVIDENCE_PER_CONCEPT)
    : []
  const progress: ConceptProgress = {
    conceptId,
    courseId,
    level: rawLevel,
    review: o.review === true,
    evidence,
    updatedAt: Number.isFinite(Number(o.updatedAt)) ? Number(o.updatedAt) : 0
  }
  const self = o.selfAssessment
  if (self && typeof self === 'object') {
    const s = self as Record<string, unknown>
    const kind = s.kind === 'got-it' || s.kind === 'suspect' ? (s.kind as SelfAssessmentKind) : null
    if (kind) {
      const text = clampText(s.text, MAX_SELF_ASSESSMENT_CHARS)
      progress.selfAssessment = {
        kind,
        ...(text ? { text } : {}),
        at: Number.isFinite(Number(s.at)) ? Number(s.at) : progress.updatedAt
      }
    }
  }
  return progress
}

export function sanitizeLearningMemoryDocument(raw: unknown): LearningMemoryDocument {
  if (!raw || typeof raw !== 'object') return { version: 1, notes: [], progress: [], reviews: [] }
  const o = raw as Record<string, unknown>
  const notes: LearningNote[] = []
  const seenNotes = new Set<string>()
  for (const item of Array.isArray(o.notes) ? o.notes : []) {
    const note = sanitizeNote(item)
    if (!note || seenNotes.has(note.id)) continue
    seenNotes.add(note.id)
    notes.push(note)
    if (notes.length >= MAX_NOTES) break
  }
  const progress: ConceptProgress[] = []
  const seenProgress = new Set<string>()
  for (const item of Array.isArray(o.progress) ? o.progress : []) {
    const entry = sanitizeProgress(item)
    if (!entry) continue
    const key = `${entry.courseId}:${entry.conceptId}`
    if (seenProgress.has(key)) continue
    seenProgress.add(key)
    progress.push(entry)
  }
  const reviews: ReviewItem[] = []
  const seenReviews = new Set<string>()
  for (const item of Array.isArray(o.reviews) ? o.reviews : []) {
    const review = sanitizeReview(item)
    if (!review || seenReviews.has(review.id)) continue
    seenReviews.add(review.id)
    reviews.push(review)
    if (reviews.length >= MAX_REVIEWS) break
  }
  return { version: 1, notes, progress, reviews }
}

/* ------------------------------------------------------------------ *
 * 查询
 * ------------------------------------------------------------------ */

/** 同一 id 替换，不同 id 追加（笔记保存的唯一入口）。 */
export function upsertNoteIn(notes: readonly LearningNote[], note: LearningNote): LearningNote[] {
  const index = notes.findIndex((item) => item.id === note.id)
  if (index < 0) return [...notes, note]
  const next = [...notes]
  next[index] = note
  return next
}

export function notesForCourse(notes: readonly LearningNote[], courseId: string): LearningNote[] {
  return notes.filter((note) => note.courseId === courseId).sort((a, b) => b.updatedAt - a.updatedAt)
}

export function notesForUnit(notes: readonly LearningNote[], courseId: string, unitId: string): LearningNote[] {
  return notes
    .filter((note) => note.courseId === courseId && note.unitId === unitId)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function progressForCourse(progress: readonly ConceptProgress[], courseId: string): ConceptProgress[] {
  return progress.filter((item) => item.courseId === courseId)
}

export function findProgress(progress: readonly ConceptProgress[], courseId: string, conceptId: string): ConceptProgress | null {
  return progress.find((item) => item.courseId === courseId && item.conceptId === conceptId) ?? null
}

/**
 * 下次接续只带相关内容（T11-6）：当前概念 + 最近几条证据。
 *
 * 有意不做「整课程回灌」——那会让每轮上下文都被学习历史占满，
 * 而模型真正需要的只是「这个概念走到哪了」。
 */
export function learningResumeExcerpt(progress: readonly ConceptProgress[], conceptIds: readonly string[]): string {
  const lines = progress
    .filter((item) => conceptIds.includes(item.conceptId))
    .map((item) => {
      const parts = [observationLabel(item.level)]
      if (item.review) parts.push('建议复习')
      if (item.selfAssessment) parts.push(`学习者自评：${SELF_ASSESSMENT_LABELS[item.selfAssessment.kind]}`)
      return `- ${item.conceptId}：${parts.join('；')}`
    })
  return lines.join('\n')
}
