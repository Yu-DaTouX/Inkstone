/**
 * 学习状态的所有者（实施-25 P08，T08-4）。
 *
 * 它只做三件事：
 *   ① 把「学到哪、停在哪个阶段、在等谁回答」落盘并读回来；
 *   ② 给**自动续跑**一个可查询的闸门（`waitingForLearner`）；
 *   ③ 把宿主命令（`yan study …`）翻译成阶段推进，并用纯逻辑的转移表把关。
 *
 * 有意**不做**第四件事：自己定 timer、自己排下一轮。调度器只有一套
 * （自主档的 `goal` + 薄层 `goal-resume`），学习只是给它加一个「现在别叫醒」的条件 ——
 * 两套调度器会互相覆盖，最后谁也说不清「到底是谁把模型叫起来的」。
 *
 * 边界：本片不生成练习、不算进度、不给反馈内容（P10/P11）；这里只保证
 * 「阶段与等待是真的」——那才是 R3 要拦的东西。
 */

import type { Course, CourseSourceRef } from '../shared/course'
import {
  MAX_ANSWER_CHARS,
  MAX_EXPECTATION_CHARS,
  MAX_NEXT_STEP_CHARS,
  MAX_QUESTION_CHARS,
  buildStudyResume,
  isWaitingForLearner,
  makeStudyId,
  planPhaseTransition,
  studyWhere,
  type StudyCourseView,
  type StudyMutation,
  type StudyOrigin,
  type StudyPending,
  type StudyPhase,
  type StudyResume,
  type StudySession
} from '../shared/study'
import { StudyStore, type StudyGate } from './learning-store'
import { LearningMemoryStore } from './learning-memory-store'
import {
  applyProgress,
  createNote,
  evidenceFromAttempt,
  makeNoteId,
  updateNote as updateNotePure,
  validateNoteInput,
  type ConceptProgress,
  type LearningNote,
  type NoteMutation,
  type ProgressEvidence,
  type SelfAssessmentKind
} from '../shared/learning-memory'
import type { Attempt, Exercise } from '../shared/exercise'
import {
  MAX_REVIEW_PROMPT,
  REVIEW_CLEAR_STREAK,
  REVIEW_QUESTION_REPEAT,
  makeReviewId,
  planReview,
  scheduleReview,
  type ReviewItem,
  type ReviewPlan,
  type ReviewPriority,
  type ReviewReason
} from '../shared/review'

/** 复习项写操作的收口：失败都说清楚原因（找不到了 / 缺少 id）。 */
export type ReviewMutation = { ok: true; review: ReviewItem } | { ok: false; reason: string }

/** 只要「按 id 找课程」这一件事，好让单测不必造整个 `CourseStore`。 */
export interface LearningCourseSource {
  find(id: string): Course | null | undefined
}

export interface LearningServiceOptions {
  store?: StudyStore
  memoryStore?: LearningMemoryStore
  courses?: LearningCourseSource | null
  /**
   * 作答事实源（T11-3）：进度从它重算，不在本服务里另存一份历史。
   *
   * 写成函数而不是对象，是为了避开「练习服务需要本服务记进度」与
   * 「本服务需要练习服务的作答」之间的构造顺序问题（两者在运行时都没有循环）。
   */
  attempts?: () => Promise<{ exercises: Exercise[]; attempts: Attempt[] }>
  now?: () => number
  random?: () => number
}

export interface StudyStatus {
  session: StudySession | null
  resume: StudyResume | null
  /** 这个 pi 会话此刻是不是在等学习者作答（闸门判据）。 */
  waiting: boolean
  /** 盘上的闸门快照（排障与验收用；正常应与 `waiting` 一致）。 */
  gate: StudyGate | null
}

function clampText(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return ''
  return raw.trim().slice(0, max)
}

/**
 * 一条概念的全部证据（从作答事实源现算）。
 *
 * 同时按课程过滤：`conceptId` 虽然全局生成，但同一份事实源里可能混着别的课程，
 * 不给课程条件会把别的课的作答也算进来。
 */
function evidenceForConcept(
  courseId: string,
  conceptId: string,
  exercises: readonly Exercise[],
  attempts: readonly Attempt[]
): ProgressEvidence[] {
  const byId = new Map(exercises.map((exercise) => [exercise.id, exercise]))
  const out: ProgressEvidence[] = []
  for (const attempt of attempts) {
    const exercise = byId.get(attempt.exerciseId)
    if (!exercise || exercise.courseId !== courseId) continue
    if (!exercise.conceptIds.includes(conceptId)) continue
    out.push(evidenceFromAttempt(exercise, attempt))
  }
  return out
}

function courseView(course: Course | null): StudyCourseView | null {
  if (!course) return null
  return { id: course.id, title: course.title, units: course.units.map((unit) => ({ id: unit.id, title: unit.title })) }
}

export class LearningService {
  private readonly store: StudyStore
  private readonly memory: LearningMemoryStore
  private readonly courses: LearningCourseSource | null
  private readonly attempts: (() => Promise<{ exercises: Exercise[]; attempts: Attempt[] }>) | null
  private readonly now: () => number
  private readonly random: () => number

  constructor(options: LearningServiceOptions = {}) {
    this.store = options.store ?? new StudyStore()
    this.memory = options.memoryStore ?? new LearningMemoryStore()
    this.courses = options.courses ?? null
    this.attempts = options.attempts ?? null
    this.now = options.now ?? Date.now
    this.random = options.random ?? Math.random
  }

  /* ------------------------------ 闸门 ------------------------------ */

  /**
   * 这个 pi 会话是不是正等着学习者作答（T08-3 的宿主侧判据）。
   *
   * 只认落盘的会话本体，不认内存标志 —— 重开应用后第一次调用就会 load，
   * 所以「重启后仍被拦住」不需要任何额外机制（T08-2）。
   */
  async waitingForLearner(runtimeKey: string): Promise<boolean> {
    if (!runtimeKey) return false
    await this.store.load()
    return isWaitingForLearner(this.store.forRuntime(runtimeKey))
  }

  /* ------------------------------ 查询 ------------------------------ */

  async status(runtimeKey: string): Promise<StudyStatus> {
    await this.store.load()
    const session = this.store.forRuntime(runtimeKey)
    return {
      session,
      resume: session ? this.resumeOf(session) : null,
      waiting: isWaitingForLearner(session),
      gate: runtimeKey ? await this.store.readGate(runtimeKey) : null
    }
  }

  async statusOfCourse(courseId: string): Promise<StudyStatus> {
    await this.store.load()
    const session = this.store.forCourse(courseId)
    const runtimeKey = session?.runtimeKey ?? ''
    return {
      session,
      resume: session ? this.resumeOf(session) : null,
      waiting: isWaitingForLearner(session),
      gate: runtimeKey ? await this.store.readGate(runtimeKey) : null
    }
  }

  async list(): Promise<{ session: StudySession; resume: StudyResume }[]> {
    await this.store.load()
    return this.store
      .list()
      .map((session) => ({ session, resume: this.resumeOf(session) }))
      .sort((a, b) => b.session.updatedAt - a.session.updatedAt)
  }

  /* ------------------------------ 命令 ------------------------------ */

  /**
   * 开始或继续一门课（T08-5）。
   *
   * 复用同一门课的既有会话（位置与阶段都留着）——「接着学」与「新开一课」
   * 走同一条路，界面不需要判断该调哪个。
   */
  async start(input: { courseId: string; unitId?: string; runtimeKey: string; nextStep?: string }): Promise<StudyMutation> {
    await this.store.load()
    const runtimeKey = clampText(input.runtimeKey, 400)
    if (!runtimeKey) return { ok: false, reason: '缺少会话标识，无法绑定学习状态。' }
    const course = this.courses?.find(input.courseId) ?? null
    if (!course) return { ok: false, reason: '找不到这门课。' }
    const existing = this.store.forCourse(course.id)

    const targetUnitId = clampText(input.unitId, 80) || existing?.unitId || course.units[0]?.id || ''
    const unitIndex = course.units.findIndex((unit) => unit.id === targetUnitId)
    if (unitIndex < 0) {
      return { ok: false, reason: course.units.length ? '这一节不在课程路线里。' : '课程还没有单元，先加一节再开始。' }
    }
    const unit = course.units[unitIndex]
    const at = this.now()
    const changingUnit = !!existing && existing.unitId !== unit.id

    const session: StudySession = existing
      ? {
          ...existing,
          runtimeKey,
          unitId: unit.id,
          position: { unitIndex, ...(unit.sources[0]?.locator ? { locator: unit.sources[0].locator } : {}) },
          /* 换节 = 重新开始那一节，阶段回到准备；同一节则是「接着学」。 */
          ...(changingUnit
            ? { phase: 'preparing' as StudyPhase, pending: undefined, lastAnswer: undefined }
            : {}),
          ...(clampText(input.nextStep, MAX_NEXT_STEP_CHARS) ? { nextStep: clampText(input.nextStep, MAX_NEXT_STEP_CHARS) } : {}),
          updatedAt: at
        }
      : {
          id: makeStudyId(this.random),
          courseId: course.id,
          unitId: unit.id,
          runtimeKey,
          phase: 'preparing',
          position: { unitIndex, ...(unit.sources[0]?.locator ? { locator: unit.sources[0].locator } : {}) },
          ...(clampText(input.nextStep, MAX_NEXT_STEP_CHARS) ? { nextStep: clampText(input.nextStep, MAX_NEXT_STEP_CHARS) } : {}),
          paused: false,
          startedAt: at,
          updatedAt: at
        }

    await this.persist(session, existing?.runtimeKey, course)
    return { ok: true, session }
  }

  /**
   * 提出问题并进入「等你作答」（T08-7）。
   *
   * 这是**唯一**能进等待阶段的路：必须带问题，且要说明问的是教材里的东西
   * 还是模型自己补的（与课程的 `origin` 同一条边界）。
   */
  async ask(input: {
    runtimeKey: string
    question: string
    expectation?: string
    origin?: StudyOrigin
    sources?: CourseSourceRef[]
    nextStep?: string
  }): Promise<StudyMutation> {
    await this.store.load()
    const session = this.store.forRuntime(clampText(input.runtimeKey, 400))
    if (!session) return { ok: false, reason: '这个会话还没开始学习（先 `yan study start`）。' }
    const question = clampText(input.question, MAX_QUESTION_CHARS)
    const transition = planPhaseTransition({ from: session.phase, to: 'waiting_for_learner', hasQuestion: !!question })
    if (!transition.ok) return { ok: false, reason: transition.message }

    const at = this.now()
    const pending: StudyPending = {
      question,
      ...(clampText(input.expectation, MAX_EXPECTATION_CHARS)
        ? { expectation: clampText(input.expectation, MAX_EXPECTATION_CHARS) }
        : {}),
      origin: input.origin === 'model' ? 'model' : 'material',
      ...(Array.isArray(input.sources) && input.sources.length ? { sources: input.sources.slice(0, 20) } : {}),
      askedAt: at
    }
    const next: StudySession = {
      ...session,
      phase: 'waiting_for_learner',
      pending,
      /* 新问题作废上一次的作答：否则「上次答过」会被当成「这次答过」。 */
      lastAnswer: undefined,
      ...(clampText(input.nextStep, MAX_NEXT_STEP_CHARS) ? { nextStep: clampText(input.nextStep, MAX_NEXT_STEP_CHARS) } : {}),
      paused: false,
      updatedAt: at
    }
    await this.persist(next, session.runtimeKey, this.courseOf(session.courseId))
    return { ok: true, session: next }
  }

  /** 学习者作答（只由用户的真实输入触发）—— 也是**唯一**能离开等待阶段的路。 */
  async answer(input: { runtimeKey: string; text: string }): Promise<StudyMutation> {
    await this.store.load()
    const session = this.store.forRuntime(clampText(input.runtimeKey, 400))
    if (!session) return { ok: false, reason: '这个会话还没开始学习。' }
    const text = clampText(input.text, MAX_ANSWER_CHARS)
    if (!text) return { ok: false, reason: '作答是空的。' }
    const transition = planPhaseTransition({ from: session.phase, to: 'feedback', hasAnswer: true })
    if (!transition.ok) return { ok: false, reason: transition.message }

    const at = this.now()
    const next: StudySession = {
      ...session,
      phase: 'feedback',
      pending: undefined,
      lastAnswer: { text, at },
      updatedAt: at
    }
    await this.persist(next, session.runtimeKey, this.courseOf(session.courseId))
    return { ok: true, session: next }
  }

  /**
   * 推进阶段。
   *
   * 注意这里**不**给 `hasQuestion` / `hasAnswer`：所以这个入口既进不了等待，
   * 也出不了等待 —— 模型不能靠调它把「还没答的题」翻过去（T08-7）。
   */
  async advance(input: { runtimeKey: string; to: StudyPhase; nextStep?: string }): Promise<StudyMutation> {
    await this.store.load()
    const session = this.store.forRuntime(clampText(input.runtimeKey, 400))
    if (!session) return { ok: false, reason: '这个会话还没开始学习。' }
    const transition = planPhaseTransition({ from: session.phase, to: input.to })
    if (!transition.ok) return { ok: false, reason: transition.message }

    const at = this.now()
    const next: StudySession = {
      ...session,
      phase: input.to,
      ...(clampText(input.nextStep, MAX_NEXT_STEP_CHARS) ? { nextStep: clampText(input.nextStep, MAX_NEXT_STEP_CHARS) } : {}),
      updatedAt: at
    }
    await this.persist(next, session.runtimeKey, this.courseOf(session.courseId))
    return { ok: true, session: next }
  }

  /** 暂停：保留位置，但**不再等待**（后台准备工作可以继续做）。 */
  async pause(runtimeKey: string): Promise<StudyMutation> {
    return this.setPaused(runtimeKey, true)
  }

  /** 恢复：若停在等待阶段，闸门也跟着恢复（否则「等你作答」就成了空话）。 */
  async resume(runtimeKey: string): Promise<StudyMutation> {
    return this.setPaused(runtimeKey, false)
  }

  /** 先不学了：解绑会话但保留位置与阶段（下次 `start` 接着学）。 */
  async stop(runtimeKey: string): Promise<StudyMutation> {
    await this.store.load()
    const key = clampText(runtimeKey, 400)
    const session = this.store.forRuntime(key)
    if (!session) return { ok: false, reason: '这个会话没有正在进行的学习。' }
    const next: StudySession = { ...session, runtimeKey: '', updatedAt: this.now() }
    await this.persist(next, key, this.courseOf(session.courseId), { release: true })
    return { ok: true, session: next }
  }

  async remove(courseId: string): Promise<boolean> {
    await this.store.load()
    const session = this.store.forCourse(clampText(courseId, 80))
    if (!session) return false
    if (session.runtimeKey) await this.store.setGate(session.runtimeKey, null)
    return this.store.remove(session.id)
  }

  /* ------------------------------ 笔记（T11-1） ------------------------------ */

  async listNotes(courseId: string): Promise<LearningNote[]> {
    await this.memory.load()
    return this.memory.notes(clampText(courseId, 80))
  }

  async saveNote(input: unknown): Promise<NoteMutation> {
    const checked = validateNoteInput(input)
    if (!checked.ok) return { ok: false, reason: checked.reason }
    if (this.courses && !this.courses.find(checked.value.courseId)) return { ok: false, reason: '找不到这门课。' }
    await this.memory.load()
    const note = createNote(checked.value, this.now(), this.noteIdFactory())
    await this.memory.saveNote(note)
    return { ok: true, note }
  }

  async updateNote(id: string, patch: unknown): Promise<NoteMutation> {
    await this.memory.load()
    const current = this.memory.findNote(clampText(id, 80))
    if (!current) return { ok: false, reason: '找不到这条笔记。' }
    const result = updateNotePure(current, (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>, this.now())
    if (!result.ok || result.unchanged) return result
    await this.memory.saveNote(result.note)
    return result
  }

  async removeNote(id: string): Promise<boolean> {
    await this.memory.load()
    return this.memory.removeNote(clampText(id, 80))
  }

  /* ------------------------------ 概念进度（T11-2） ------------------------------ */

  async listProgress(courseId: string): Promise<ConceptProgress[]> {
    await this.memory.load()
    return this.memory.progress(clampText(courseId, 80))
  }

  /**
   * 用户自评（T11-5）：写进 `selfAssessment`，**不动系统观察**里的任何一个字段。
   *
   * 这也不是一个「覆盖」：`level` / `review` / `evidence` 全部原样保留，
   * 所以界面上可以同时显示「系统：曾独立完成 · 建议复习」与「我：已经会了」。
   */
  async setSelfAssessment(input: {
    courseId: string
    conceptId: string
    kind: SelfAssessmentKind
    text?: string
  }): Promise<{ ok: true; progress: ConceptProgress } | { ok: false; reason: string }> {
    const courseId = clampText(input.courseId, 80)
    const conceptId = clampText(input.conceptId, 120)
    if (!courseId || !conceptId) return { ok: false, reason: '缺少课程或概念 id。' }
    const kind: SelfAssessmentKind = input.kind === 'suspect' ? 'suspect' : 'got-it'
    const at = this.now()
    const text = clampText(input.text, 500)
    await this.memory.load()
    const existing = this.memory.findProgress(courseId, conceptId)
    const progress: ConceptProgress = existing
      ? { ...existing, selfAssessment: { kind, ...(text ? { text } : {}), at }, updatedAt: at }
      : {
          conceptId,
          courseId,
          level: 'unseen',
          review: false,
          evidence: [],
          selfAssessment: { kind, ...(text ? { text } : {}), at },
          updatedAt: at
        }
    await this.memory.saveProgress(progress)
    return { ok: true, progress }
  }

  /** 清掉一条概念的观察记录（用户说「重新算」）。 */
  async resetProgress(courseId: string, conceptId: string): Promise<boolean> {
    await this.memory.load()
    return this.memory.removeConcept(clampText(courseId, 80), clampText(conceptId, 120))
  }

  /**
   * 提交作答后重算进度（T11-3）：**`Attempt` 是事实源**，这里只做摘要。
   *
   * 概念对应的证据从作答事实源现场重算，所以「删掉一次作答」或「改了练习的概念」
   * 之后再算一遍，结果会跟着变 —— 不会留下一份跟不上事实的旧摘要。
   */
  async recordAttempt(attempt: Attempt, exercise: Exercise): Promise<void> {
    if (!this.attempts || exercise.conceptIds.length === 0) return
    const source = await this.attempts()
    await this.memory.load()
    /* 本次这一条的观察（复习排期看的是**这一次**，与「累计证据」分开）。 */
    const thisEvidence = evidenceFromAttempt(exercise, attempt)
    for (const conceptId of exercise.conceptIds) {
      const evidence = evidenceForConcept(exercise.courseId, conceptId, source.exercises, source.attempts)
      const existing = this.memory.findProgress(exercise.courseId, conceptId)
      await this.memory.saveProgress(applyProgress(conceptId, exercise.courseId, evidence, existing, this.now()))
      /* 同一次作答同时喂两条轴：进度回答「学到哪一步」，复习回答「什么时候再看」。 */
      await this.recordReview(exercise, conceptId, thisEvidence)
    }
  }

  /**
   * 删课程时一并收拾它的笔记、进度与复习项。
   */
  async removeMemory(courseId: string): Promise<{ notes: number; progress: number; reviews: number }> {
    await this.memory.load()
    return this.memory.removeCourse(clampText(courseId, 80))
  }

  /* ------------------------------ 错题与复习（P12） ------------------------------ */

  /** 列复习项；不传 `courseId` 就是全部课程（首页「今天可复习」用）。 */
  async listReviews(courseId?: string): Promise<ReviewItem[]> {
    await this.memory.load()
    return this.memory.reviews(clampText(courseId, 80) ?? undefined)
  }

  /**
   * 今天的复习计划（T12-5）：只挑题，**不自动开始学**。
   *
   * `quick` 是「今天十分钟」——在到期之外也把优先项算上，卡在时间预算内。
   */
  async planToday(
    courseId: string,
    options: { mode?: 'due' | 'quick'; minutesBudget?: number } = {}
  ): Promise<ReviewPlan> {
    await this.memory.load()
    const id = clampText(courseId, 80)
    const source = this.attempts ? await this.attempts() : { exercises: [], attempts: [] }
    return planReview({
      items: this.memory.reviews(id),
      exercises: source.exercises.filter((e) => e.courseId === id),
      attempts: source.attempts.filter((a) => a.courseId === id),
      now: this.now(),
      ...(options.mode ? { mode: options.mode } : {}),
      ...(options.minutesBudget !== undefined ? { minutesBudget: options.minutesBudget } : {})
    })
  }

  /**
   * 「这段原文没看懂」（T12-2 第一类）：不带题，复习时重看这一段。
   *
   * 判对判错都不适用 —— 它不是一次作答，而是一个还没解决的问题。
   */
  async flagReading(input: {
    courseId: string
    unitId?: string
    sourceId: string
    version?: number
    locator?: { start: number; end: number }
    note?: string
  }): Promise<ReviewMutation> {
    const courseId = clampText(input.courseId, 80)
    const sourceId = clampText(input.sourceId, 120)
    if (!courseId || !sourceId) return { ok: false, reason: '缺少课程或资料 id。' }
    if (this.courses && !this.courses.find(courseId)) return { ok: false, reason: '找不到这门课。' }
    await this.memory.load()
    const at = this.now()
    const locator = input.locator
    const existing =
      this.memory
        .reviews(courseId)
        .find(
          (item) =>
            item.reason === 'misread' &&
            item.source?.sourceId === sourceId &&
            (item.source?.locator?.start ?? -1) === (locator?.start ?? -1)
        ) ?? null
    const scheduled = scheduleReview({ reason: 'misread', correct: null, independent: false, stage: existing?.stage, now: at })
    const item = this.buildReview({
      existing,
      courseId,
      reason: 'misread',
      prompt: clampText(input.note, MAX_REVIEW_PROMPT) ?? '这一段上次没看懂，回头看一遍原文。',
      source: { sourceId, version: Math.max(1, Math.trunc(input.version ?? 1)), ...(locator ? { locator } : {}) },
      ...(clampText(input.unitId, 120) ? { unitId: String(input.unitId) } : {}),
      scheduled,
      at
    })
    await this.memory.saveReview(item)
    return { ok: true, review: item }
  }

  /**
   * 「这个概念我反复问」（T12-2 第二类）。
   *
   * 第一次问就轻轻记下（优先级 `low`，1 天后），问到第
   * `REVIEW_QUESTION_REPEAT` 次才提上来 —— 因为「问过一次」可能是好奇，
   * 「问第二次」才说明前面那次没解决。
   */
  async flagQuestion(input: { courseId: string; conceptId: string; text?: string }): Promise<ReviewMutation> {
    const courseId = clampText(input.courseId, 80)
    const conceptId = clampText(input.conceptId, 120)
    if (!courseId || !conceptId) return { ok: false, reason: '缺少课程或概念 id。' }
    if (this.courses && !this.courses.find(courseId)) return { ok: false, reason: '找不到这门课。' }
    await this.memory.load()
    const at = this.now()
    const existing = this.memory.reviews(courseId).find((item) => item.conceptId === conceptId) ?? null
    const seenCount = (existing?.seenCount ?? 0) + 1
    /* 已经是错题项：只累加「又问了一次」，不改它的来因与档位。 */
    if (existing && existing.reason !== 'repeated-question') {
      const next = { ...existing, seenCount, updatedAt: at }
      await this.memory.saveReview(next)
      return { ok: true, review: next }
    }
    const scheduled = scheduleReview({
      reason: 'repeated-question',
      correct: null,
      independent: false,
      stage: 0,
      now: at
    })
    const item = this.buildReview({
      existing,
      courseId,
      conceptId,
      reason: 'repeated-question',
      prompt: clampText(input.text, MAX_REVIEW_PROMPT) ?? '这个概念问过不止一次，再看一遍。',
      scheduled: { ...scheduled, priority: seenCount >= REVIEW_QUESTION_REPEAT ? 'high' : 'low' },
      seenCount,
      at
    })
    await this.memory.saveReview(item)
    return { ok: true, review: item }
  }

  /**
   * 改一条复习的排期（T12-4「透明可编辑」）。
   *
   * 用户说「今天不想看这个」就往后挪，「现在就练」就拉到眼前 —— 只动
   * `dueAt` / `priority`，不改来因与档位（规则仍然是那一套）。
   */
  async rescheduleReview(
    id: string,
    patch: { dueAt?: number; priority?: ReviewPriority }
  ): Promise<ReviewMutation> {
    await this.memory.load()
    const current = this.memory.findReview(clampText(id, 80))
    if (!current) return { ok: false, reason: '找不到这条复习。' }
    const dueAt =
      typeof patch.dueAt === 'number' && Number.isFinite(patch.dueAt) ? Math.trunc(patch.dueAt) : current.dueAt
    const priority: ReviewPriority = (['high', 'normal', 'low'] as const).includes(patch.priority as ReviewPriority)
      ? (patch.priority as ReviewPriority)
      : current.priority
    const next = { ...current, dueAt, priority, updatedAt: this.now() }
    await this.memory.saveReview(next)
    return { ok: true, review: next }
  }

  async dismissReview(id: string): Promise<boolean> {
    await this.memory.load()
    return this.memory.removeReview(clampText(id, 80))
  }

  private reviewCounter = 0

  private reviewIdFactory(): string {
    const taken = new Set(this.memory.reviews().map((item) => item.id))
    for (let i = 0; i < 50; i++) {
      const id = makeReviewId(this.random)
      if (!taken.has(id)) return id
    }
    this.reviewCounter += 1
    return `rv_${this.reviewCounter.toString(36)}_${this.now().toString(36)}`
  }

  /** 建 / 覆盖一条复习项：公共字段只在这里拼一次，避免各处漏字段。 */
  private buildReview(input: {
    existing: ReviewItem | null
    courseId: string
    reason: ReviewReason
    prompt: string
    scheduled: { dueAt: number; stage: number; priority: ReviewPriority }
    at: number
    conceptId?: string
    unitId?: string
    attemptId?: string
    exerciseId?: string
    source?: ReviewItem['source']
    seenCount?: number
    prerequisiteConceptId?: string
  }): ReviewItem {
    const conceptId = input.conceptId ?? input.existing?.conceptId
    const unitId = input.unitId ?? input.existing?.unitId
    return {
      id: input.existing?.id ?? this.reviewIdFactory(),
      courseId: input.courseId,
      ...(conceptId ? { conceptId } : {}),
      ...(unitId ? { unitId } : {}),
      reason: input.reason,
      ...(input.attemptId ? { attemptId: input.attemptId } : input.existing?.attemptId ? { attemptId: input.existing.attemptId } : {}),
      ...(input.exerciseId ? { exerciseId: input.exerciseId } : input.existing?.exerciseId ? { exerciseId: input.existing.exerciseId } : {}),
      prompt: input.prompt,
      ...(input.source ? { source: input.source } : input.existing?.source ? { source: input.existing.source } : {}),
      dueAt: input.scheduled.dueAt,
      stage: input.scheduled.stage,
      priority: input.scheduled.priority,
      streak: 0,
      seenCount: Math.max(1, Math.trunc(input.seenCount ?? (input.existing?.seenCount ?? 0) + 1)),
      ...(input.prerequisiteConceptId ? { prerequisiteConceptId: input.prerequisiteConceptId } : {}),
      createdAt: input.existing?.createdAt ?? input.at,
      updatedAt: input.at
    }
  }

  /**
   * 一次作答对复习列表的影响（T12-1 / T12-4）。
   *
   * 独立成功不会「新增」复习 —— 它只把已有的往后推，连推两次独立成功就收掉；
   * 做错 / 用提示才建项；开放题（没判定）**什么都不做**（不能把「没判错」
   * 当成学会了，也不能凭空建一条错题）。
   */
  private async recordReview(exercise: Exercise, conceptId: string, evidence: ProgressEvidence): Promise<void> {
    const at = this.now()
    const existing = this.memory.reviews(exercise.courseId).find((item) => item.conceptId === conceptId) ?? null
    if (evidence.independent) {
      if (!existing) return
      const streak = existing.streak + 1
      if (streak >= REVIEW_CLEAR_STREAK) {
        await this.memory.removeReview(existing.id)
        return
      }
      const scheduled = scheduleReview({
        reason: existing.reason,
        correct: true,
        independent: true,
        transfer: evidence.transfer,
        stage: existing.stage,
        now: at
      })
      await this.memory.saveReview({
        ...existing,
        streak,
        dueAt: scheduled.dueAt,
        stage: scheduled.stage,
        priority: scheduled.priority,
        attemptId: evidence.attemptId,
        exerciseId: exercise.id,
        seenCount: existing.seenCount + 1,
        updatedAt: at
      })
      return
    }
    if (evidence.correct === null) return
    const reason: ReviewReason =
      evidence.correct === false ? (exercise.kind === 'apply' ? 'not-transferable' : 'wrong-answer') : 'hinted'
    const scheduled = scheduleReview({
      reason,
      correct: evidence.correct,
      independent: false,
      stage: existing?.stage,
      now: at
    })
    await this.memory.saveReview(
      this.buildReview({
        existing,
        courseId: exercise.courseId,
        conceptId,
        reason,
        /* 题面缺失的（早版本数据）用题目 id 兵底，不让一条复习项因为显示文案而建不出来。 */
        prompt: String(exercise.prompt ?? exercise.id).slice(0, MAX_REVIEW_PROMPT),
        attemptId: evidence.attemptId,
        exerciseId: exercise.id,
        scheduled,
        at
      })
    )
  }

  /** 碰撞回退用的递增计数器（笔记 id 撞车时才用得上）。 */
  private noteCounter = 0

  /* ------------------------------ 内部 ------------------------------ */

  private noteIdFactory(): string {
    const taken = new Set(this.memory.notes().map((item) => item.id))
    for (let i = 0; i < 50; i++) {
      const id = makeNoteId(this.random)
      if (!taken.has(id)) return id
    }
    this.noteCounter += 1
    return `nt_${this.noteCounter.toString(36)}_${this.now().toString(36)}`
  }

  private async setPaused(runtimeKey: string, paused: boolean): Promise<StudyMutation> {
    await this.store.load()
    const key = clampText(runtimeKey, 400)
    const session = this.store.forRuntime(key)
    if (!session) return { ok: false, reason: '这个会话没有正在进行的学习。' }
    if (session.paused === paused) return { ok: true, session, unchanged: true }
    const next: StudySession = { ...session, paused, updatedAt: this.now() }
    await this.persist(next, key, this.courseOf(session.courseId))
    return { ok: true, session: next }
  }

  private courseOf(courseId: string): Course | null {
    return this.courses?.find(courseId) ?? null
  }

  private resumeOf(session: StudySession): StudyResume {
    return buildStudyResume(session, courseView(this.courseOf(session.courseId)))
  }

  /**
   * 落盘 + 同步闸门（唯一的写入口）。
   *
   * 顺序有意是「先写会话本体，再写闸门」：闸门是从本体派生的拷贝，
   * 反过来先写闸门、后写本体，崩溃后就会留下「闸门说在等，本体却说没等」的假等待。
   */
  private async persist(
    session: StudySession,
    previousKey: string | undefined,
    course: Course | null,
    opts: { release?: boolean } = {}
  ): Promise<void> {
    await this.store.save(session)
    const resume = buildStudyResume(session, courseView(course))
    const waiting = !opts.release && isWaitingForLearner(session)
    if (waiting) {
      await this.store.setGate(session.runtimeKey, {
        version: 1,
        waiting: true,
        sessionId: session.id,
        courseId: session.courseId,
        unitId: session.unitId,
        where: studyWhere(resume),
        at: this.now()
      })
    } else if (session.runtimeKey) {
      await this.store.setGate(session.runtimeKey, null)
    }
    /* 换过绑定的会话（或解绑）：旧 runnerId 的闸门必须一起收掉 */
    if (previousKey && previousKey !== session.runtimeKey) await this.store.setGate(previousKey, null)
  }
}
