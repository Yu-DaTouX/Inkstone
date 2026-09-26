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

/** 只要「按 id 找课程」这一件事，好让单测不必造整个 `CourseStore`。 */
export interface LearningCourseSource {
  find(id: string): Course | null | undefined
}

export interface LearningServiceOptions {
  store?: StudyStore
  courses?: LearningCourseSource | null
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

function courseView(course: Course | null): StudyCourseView | null {
  if (!course) return null
  return { id: course.id, title: course.title, units: course.units.map((unit) => ({ id: unit.id, title: unit.title })) }
}

export class LearningService {
  private readonly store: StudyStore
  private readonly courses: LearningCourseSource | null
  private readonly now: () => number
  private readonly random: () => number

  constructor(options: LearningServiceOptions = {}) {
    this.store = options.store ?? new StudyStore()
    this.courses = options.courses ?? null
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

  /* ------------------------------ 内部 ------------------------------ */

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
