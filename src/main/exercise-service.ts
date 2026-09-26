/**
 * 练习服务（实施-25 P10）：出题、揭示、作答、反馈。
 *
 * ══════════════════════════════════════════════════════════
 * 两件事分开：题目可见性 与 作答事实
 * ══════════════════════════════════════════════════════════
 *   · **给界面的永远是 `ExerciseView`（不含答案）**。答案只在显式的
 *     `revealSolution` 之后返回，并且这次揭示会被记进作答（T10-2）。
 *   · **提交作答时的「看了多少帮助」由服务自己记**，不信客户端传进来的值。
 *     如果让界面自报「我没看提示」，那这条防线的强度就取决于界面老实不老实。
 *
 * 判分与反馈是纯函数（`shared/exercise.ts`）：宿主只知道对错与帮助层级，
 * 不知道学习者的思路，所以开放题如实交给模型（`needsModel`），不装懂。
 */

import type { Course } from '../shared/course'
import {
  buildFeedback,
  createExercise,
  draftExercisesFromText,
  exerciseView,
  gradeResponse,
  highestHint,
  isObjectiveKind,
  makeAttemptId,
  makeExerciseId,
  revealHints,
  serializeResponse,
  validateExerciseInput,
  type Attempt,
  type AttemptFeedback,
  type Exercise,
  type ExerciseMutation,
  type ExerciseResponse,
  type ExerciseView,
  type HintLevel
} from '../shared/exercise'
import { ExerciseStore } from './exercise-store'
import type { LibraryReader } from './course-service'

/** 只要「按 id 找课程」，单测不必造整个 CourseService。 */
export interface ExerciseCourseSource {
  find(id: string): Course | null | undefined
}

export interface ExerciseServiceOptions {
  store?: ExerciseStore
  courses: ExerciseCourseSource
  library: LibraryReader
  /**
   * 作答之后把这次记录交给学习记忆（T11-3）。
   *
   * 反过来由学习服务去读练习库也可以，但那样「练了但没记进度」的窗口
   * 会取决于调用方记得不记得多调一步；写成 sink 之后，submit 只有一条路。
   */
  memory?: ExerciseMemorySink
  now?: () => number
  random?: () => number
}

/** 学习记忆只需要这两件事：记一次作答、拿去算进度。 */
export interface ExerciseMemorySink {
  recordAttempt(attempt: Attempt, exercise: Exercise): Promise<void>
}

/** 供学习服务重算进度用的作答事实源。 */
export interface ExerciseSnapshotForMemory {
  exercises: Exercise[]
  attempts: Attempt[]
}

export interface ExerciseSubmitResult {
  ok: true
  attempt: Attempt
  feedback: AttemptFeedback
}

export interface ExerciseReveal {
  ok: true
  hints: { level: HintLevel; text: string }[]
  hasMoreHints: boolean
}

/** 出一道题时从材料里读多少正文（够出几道题即可，不为出题读整本）。 */
export const EXERCISE_SOURCE_MAX_CHARS = 8000

export class ExerciseService {
  readonly store: ExerciseStore
  private readonly courses: ExerciseCourseSource
  private readonly library: LibraryReader
  private readonly memory: ExerciseMemorySink | null
  private readonly now: () => number
  private readonly random: () => number

  /**
   * 每道题「已经揭示到哪一层」的会话内记录。
   *
   * 有意**不落盘**：提示的揭示是这次学习里的动作，重开一次重新点没有损失；
   * 而一旦落盘，反而会被当成「学习者掌握程度」的证据（那是 P11 的事）。
   */
  private readonly revealed = new Map<string, { hints: Set<HintLevel>; solution: boolean }>()

  /** 碰撞回退用的递增计数器（只在随机 id 反复撞车时才用得上）。 */
  private idCounter = 0

  constructor(options: ExerciseServiceOptions) {
    this.store = options.store ?? new ExerciseStore()
    this.courses = options.courses
    this.library = options.library
    this.memory = options.memory ?? null
    this.now = options.now ?? Date.now
    this.random = options.random ?? Math.random
  }

  /* ------------------------------ 出题 ------------------------------ */

  async create(input: unknown): Promise<ExerciseMutation> {
    const checked = validateExerciseInput(input)
    if (!checked.ok) return { ok: false, reason: checked.reason }
    const course = this.courses.find(checked.value.courseId)
    if (!course) return { ok: false, reason: '找不到这门课。' }
    if (!course.units.some((unit) => unit.id === checked.value.unitId)) {
      return { ok: false, reason: '这一节不在课程路线里。' }
    }
    await this.store.load()
    const exercise = createExercise(checked.value, this.now(), this.exerciseIdFactory())
    if (!exercise.ok) return exercise
    await this.store.saveExercise(exercise.exercise)
    return exercise
  }

  /**
   * 从这一节的材料生成确定性的练习题（宿主规则，不接模型）。
   *
   * 生成出来的题 `origin: 'material'`，题面与答案都取自原文 ——
   * 宁可出得朴素，也不让「AI 编的题」冒充「书上的题」。
   */
  async createFromUnit(input: { courseId: string; unitId: string; maxExercises?: number }): Promise<
    { ok: true; exercises: Exercise[]; created: number } | { ok: false; reason: string }
  > {
    const course = this.courses.find(input.courseId)
    if (!course) return { ok: false, reason: '找不到这门课。' }
    const unit = course.units.find((item) => item.id === input.unitId)
    if (!unit) return { ok: false, reason: '这一节不在课程路线里。' }
    const ref = unit.sources[0]
    if (!ref) return { ok: false, reason: '这一节没有指回资料（是导师补充的），可以让导师出题。' }

    let text = ''
    try {
      const opened = await this.library.openRef({ sourceId: ref.sourceId, version: ref.version }, { maxChars: EXERCISE_SOURCE_MAX_CHARS })
      if (opened.outcome === 'ok' && opened.text) text = opened.text
    } catch {
      text = ''
    }
    if (!text.trim()) return { ok: false, reason: '这一节的原文读不到，出不了题。' }

    const drafts = draftExercisesFromText(text, { unitTitle: unit.title, maxExercises: input.maxExercises ?? 3 })
    if (drafts.length === 0) return { ok: false, reason: '这一段里没有可出的题。' }

    await this.store.load()
    const created: Exercise[] = []
    /* 一次生成多道题：id 必须逐道唯一（否则后一道会把前一道覆盖掉）。 */
    const makeId = this.exerciseIdFactory()
    for (const draft of drafts) {
      const input2 = {
        courseId: course.id,
        unitId: unit.id,
        conceptIds: [],
        kind: draft.kind,
        prompt: draft.prompt,
        answer: draft.answer,
        hints: draft.hints,
        ...(draft.solution ? { solution: draft.solution } : {}),
        origin: draft.origin,
        sources: [ref]
      }
      const made = createExercise(input2, this.now(), makeId)
      if (!made.ok) continue
      await this.store.saveExercise(made.exercise)
      created.push(made.exercise)
    }
    return { ok: true, exercises: created, created: created.length }
  }

  /* ------------------------------ 查询 ------------------------------ */

  async listForUnit(courseId: string, unitId: string): Promise<ExerciseView[]> {
    await this.store.load()
    return this.store
      .listExercises()
      .filter((exercise) => exercise.courseId === courseId && exercise.unitId === unitId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((exercise) => this.viewOf(exercise))
  }

  async listForCourse(courseId: string): Promise<ExerciseView[]> {
    await this.store.load()
    return this.store
      .listExercises()
      .filter((exercise) => exercise.courseId === courseId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((exercise) => this.viewOf(exercise))
  }

  async find(id: string): Promise<ExerciseView | null> {
    await this.store.load()
    const exercise = this.store.findExercise(id)
    return exercise ? this.viewOf(exercise) : null
  }

  async attempts(exerciseId: string): Promise<Attempt[]> {
    await this.store.load()
    return this.store.attemptsOf(exerciseId)
  }

  /* ------------------------------ 揭示 ------------------------------ */

  /**
   * 揭示到某一层提示（逐层给，不许跳层）。
   *
   * 跳层等于把「完整示例」提前给了，和直接看答案没有区别 ——
   * 那会让分层提示变成摆设。
   */
  async revealHint(input: { exerciseId: string; upto: HintLevel }): Promise<ExerciseReveal | { ok: false; reason: string }> {
    await this.store.load()
    const exercise = this.store.findExercise(input.exerciseId)
    if (!exercise) return { ok: false, reason: '找不到这道题。' }
    const hints = revealHints(exercise, input.upto)
    if (hints.length === 0) return { ok: false, reason: '这道题没有这一层提示。' }
    const state = this.stateOf(exercise.id)
    for (const hint of hints) state.hints.add(hint.level)
    return { ok: true, hints: hints.map((hint) => ({ ...hint })), hasMoreHints: state.hints.size < exercise.hints.length }
  }

  /** 看完整解释 —— 这一步会被记进下一次作答（`lookedAtSolution`）。 */
  async revealSolution(exerciseId: string): Promise<{ ok: true; solution: string | null } | { ok: false; reason: string }> {
    await this.store.load()
    const exercise = this.store.findExercise(exerciseId)
    if (!exercise) return { ok: false, reason: '找不到这道题。' }
    if (!exercise.solution) return { ok: true, solution: null }
    this.stateOf(exercise.id).solution = true
    return { ok: true, solution: exercise.solution }
  }

  /* ------------------------------ 作答 ------------------------------ */

  /**
   * 提交作答：判分（客观题）、记录帮助层级、追加一次 `Attempt`、给反馈。
   *
   * `hintLevelSeen` / `lookedAtSolution` 由服务自己算（见文件头），
   * 所以界面伪造「我没看提示」不会影响记录。
   */
  async submit(input: { exerciseId: string; response: ExerciseResponse }): Promise<ExerciseSubmitResult | { ok: false; reason: string }> {
    await this.store.load()
    const exercise = this.store.findExercise(input.exerciseId)
    if (!exercise) return { ok: false, reason: '找不到这道题。' }
    const raw = serializeResponse(input.response).slice(0, 8000)
    if (!raw.trim() && input.response.kind !== 'open' && input.response.kind !== 'text') {
      return { ok: false, reason: '作答是空的。' }
    }
    const state = this.stateOf(exercise.id)
    const at = this.now()
    const attempt = await this.store.addAttempt({
      id: this.attemptIdFactory()(),
      exerciseId: exercise.id,
      courseId: exercise.courseId,
      unitId: exercise.unitId,
      raw,
      correct: gradeResponse(exercise, input.response),
      hintLevelSeen: highestHint([...state.hints]),
      lookedAtSolution: state.solution,
      at
    })
    const feedback = buildFeedback(exercise, attempt)
    /*
     * 进度在**事实落盘之后**才重算：先有 `Attempt`，才有摘要。
     * 失败不该把作答本身报错（作答已经记下了），所以这里吞掉异常。
     */
    try {
      await this.memory?.recordAttempt(attempt, exercise)
    } catch {
      /* 进度重算失败不影响这次作答已经生效 */
    }
    return { ok: true, attempt, feedback }
  }

  /** 作答事实源（给学习服务算进度用）：题目与作答一起给，免得它再读一遍盘。 */
  async snapshotForMemory(): Promise<ExerciseSnapshotForMemory> {
    await this.store.load()
    return { exercises: this.store.listExercises(), attempts: this.store.listAttempts() }
  }

  /**
   * 用户纠正 agent 的判断（T10-5）。
   *
   * `correct` 不传时表示「按用户说的反过来」——用户说「判错了」通常就是这一个意思；
   * 传了就按传的记。无论哪种，原判定依据都保留。
   */
  async correct(input: { attemptId: string; text: string; correct?: boolean | null }): Promise<Attempt | { ok: false; reason: string }> {
    await this.store.load()
    const attempts = this.store.listAttempts()
    const current = attempts.find((item) => item.id === input.attemptId)
    if (!current) return { ok: false, reason: '找不到这次作答。' }
    const text = typeof input.text === 'string' ? input.text.trim() : ''
    if (!text) return { ok: false, reason: '说说哪里判得不对（这句会被记下来）。' }
    const nextCorrect = input.correct === undefined ? (current.correct === null ? null : !current.correct) : input.correct
    const updated = await this.store.correctAttempt({ attemptId: input.attemptId, text, correct: nextCorrect, at: this.now() })
    return updated ?? { ok: false, reason: '找不到这次作答。' }
  }

  /* ------------------------------ 删除 ------------------------------ */

  async remove(exerciseId: string): Promise<boolean> {
    await this.store.load()
    const removed = await this.store.removeExercise(exerciseId)
    if (removed) this.revealed.delete(exerciseId)
    return removed
  }

  async removeCourse(courseId: string): Promise<number> {
    await this.store.load()
    const removed = await this.store.removeCourse(courseId)
    for (const exercise of this.store.listExercises()) {
      if (exercise.courseId === courseId) this.revealed.delete(exercise.id)
    }
    return removed
  }

  /* ------------------------------ 内部 ------------------------------ */

  /**
   * 题目 id 工厂：保证在本 store 内唯一。
   *
   * 为什么不直接用 `makeExerciseId(random)`：存储是**按 id 替换**，
   * 一旦两道题撞了 id，后一道会把前一道覆盖掉。单测里把 random 固定就能复现，
   * 所以这里显式查重、撞了就重试。
   */
  private exerciseIdFactory(): () => string {
    const taken = new Set(this.store.listExercises().map((item) => item.id))
    return () => {
      for (let i = 0; i < 50; i++) {
        const id = makeExerciseId(this.random)
        if (!taken.has(id)) {
          taken.add(id)
          return id
        }
      }
      let id = ''
      do {
        this.idCounter += 1
        id = `ex_${this.idCounter.toString(36)}_${this.now().toString(36)}`
      } while (taken.has(id))
      taken.add(id)
      return id
    }
  }

  /** 作答 id 工厂（同一个道理：作答是事实源，不能被后来的写入顶掉）。 */
  private attemptIdFactory(): () => string {
    const taken = new Set(this.store.listAttempts().map((item) => item.id))
    return () => {
      for (let i = 0; i < 50; i++) {
        const id = makeAttemptId(this.random)
        if (!taken.has(id)) {
          taken.add(id)
          return id
        }
      }
      let id = ''
      do {
        this.idCounter += 1
        id = `at_${this.idCounter.toString(36)}_${this.now().toString(36)}`
      } while (taken.has(id))
      taken.add(id)
      return id
    }
  }

  private stateOf(exerciseId: string): { hints: Set<HintLevel>; solution: boolean } {    const existing = this.revealed.get(exerciseId)
    if (existing) return existing
    const created = { hints: new Set<HintLevel>(), solution: false }
    this.revealed.set(exerciseId, created)
    return created
  }

  private viewOf(exercise: Exercise): ExerciseView {
    const state = this.revealed.get(exercise.id)
    return exerciseView(exercise, state ? [...state.hints] : [])
  }
}

/** 客观题（界面显示「判对错」）与开放题的分界，透出给界面用。 */
export { isObjectiveKind }
