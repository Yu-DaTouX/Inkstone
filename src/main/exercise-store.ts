/**
 * 练习与作答的落盘（实施-25 P10）。
 *
 * 一份文档 `YAN_DIR/exercises.json`，同时装题目与作答：
 *   · 题目（`exercises`）是学习者要做的题；
 *   · 作答（`attempts`）是**事实源** —— P11 的概念进度只是它的稳定摘要。
 *
 * 合成一份而不是分两个文件，是因为两者的生命周期绑在一起：删一道题就必须
 * 带走它的作答（否则 P11 会从「孤儿 Attempt」里读出没人做过的题），
 * 放在一次原子写里最省事，也不会出现「题删了、作答还在」的中间态。
 *
 * 落盘策略与其它 store 一致：写队列串行 + 临时文件原子替换 + 读盘容错。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { YAN_DIR } from './paths'
import {
  MAX_CORRECTION_CHARS,
  attemptsForExercise,
  sanitizeExerciseDocument,
  type Attempt,
  type Exercise,
  type ExerciseDocument,
  type HintLevel
} from '../shared/exercise'

export const EXERCISE_FILE_NAME = 'exercises.json'

export function exerciseDocumentPath(root: string = YAN_DIR): string {
  return join(root, EXERCISE_FILE_NAME)
}

export interface AttemptInput {
  exerciseId: string
  courseId: string
  unitId: string
  raw: string
  correct: boolean | null
  hintLevelSeen: HintLevel | 'none'
  lookedAtSolution: boolean
  at: number
  id: string
}

export interface ExerciseStoreOptions {
  root?: string
}

export class ExerciseStore {
  private readonly root: string
  private doc: ExerciseDocument = { version: 1, exercises: [], attempts: [] }
  private loaded = false
  private tail: Promise<unknown> = Promise.resolve()

  constructor(options: ExerciseStoreOptions = {}) {
    this.root = options.root ?? YAN_DIR
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const text = await readFile(exerciseDocumentPath(this.root), 'utf8')
      this.doc = sanitizeExerciseDocument(JSON.parse(text))
    } catch {
      this.doc = { version: 1, exercises: [], attempts: [] }
    }
  }

  snapshot(): ExerciseDocument {
    return { version: 1, exercises: [...this.doc.exercises], attempts: [...this.doc.attempts] }
  }

  listExercises(): Exercise[] {
    return [...this.doc.exercises]
  }

  findExercise(id: string): Exercise | null {
    return this.doc.exercises.find((item) => item.id === id) ?? null
  }

  listAttempts(): Attempt[] {
    return [...this.doc.attempts]
  }

  attemptsOf(exerciseId: string): Attempt[] {
    return attemptsForExercise(this.doc.attempts, exerciseId)
  }

  /** 删一道题（连同它的作答）。返回是否真的删掉了。 */
  async removeExercise(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      if (!this.findExercise(id)) return false
      this.doc = {
        version: 1,
        exercises: this.doc.exercises.filter((item) => item.id !== id),
        attempts: this.doc.attempts.filter((item) => item.exerciseId !== id)
      }
      await this.persist()
      return true
    })
  }

  /** 删一门课的全部题目与作答（课程被删时一并收拾）。 */
  async removeCourse(courseId: string): Promise<number> {
    return this.enqueue(async () => {
      const before = this.doc.exercises.length
      this.doc = {
        version: 1,
        exercises: this.doc.exercises.filter((item) => item.courseId !== courseId),
        attempts: this.doc.attempts.filter((item) => item.courseId !== courseId)
      }
      const removed = before - this.doc.exercises.length
      if (removed > 0) await this.persist()
      return removed
    })
  }

  /** 落一道题（同 id 替换）。 */
  async saveExercise(exercise: Exercise): Promise<Exercise> {
    return this.enqueue(async () => {
      const index = this.doc.exercises.findIndex((item) => item.id === exercise.id)
      const exercises = [...this.doc.exercises]
      if (index < 0) exercises.push(exercise)
      else exercises[index] = exercise
      this.doc = { version: 1, exercises, attempts: this.doc.attempts }
      await this.persist()
      return exercise
    })
  }

  /** 追加一次作答（作答只增不改 —— 事实源不能被后来的动作“修正”掉）。 */
  async addAttempt(input: AttemptInput): Promise<Attempt> {
    return this.enqueue(async () => {
      const attempt: Attempt = {
        id: input.id,
        exerciseId: input.exerciseId,
        courseId: input.courseId,
        unitId: input.unitId,
        raw: input.raw,
        correct: input.correct,
        hintLevelSeen: input.hintLevelSeen,
        lookedAtSolution: input.lookedAtSolution,
        at: input.at
      }
      this.doc = { version: 1, exercises: this.doc.exercises, attempts: [...this.doc.attempts, attempt].slice(-20000) }
      await this.persist()
      return attempt
    })
  }

  /**
   * 记录用户对判定的纠正（T10-5）。
   *
   * 只改 `correction` 与据此更新的 `correct`，**不覆盖**原来的判定依据 ——
   * 用户说什么就是什么，但「系统当时怎么判的」也要留着（两者并存，互不覆盖）。
   */
  async correctAttempt(input: { attemptId: string; text: string; correct: boolean | null; at: number }): Promise<Attempt | null> {
    return this.enqueue(async () => {
      const index = this.doc.attempts.findIndex((item) => item.id === input.attemptId)
      if (index < 0) return null
      const current = this.doc.attempts[index]
      const next: Attempt = {
        ...current,
        correct: input.correct ?? current.correct,
        correction: { text: input.text.slice(0, MAX_CORRECTION_CHARS), correct: input.correct, at: input.at }
      }
      const attempts = [...this.doc.attempts]
      attempts[index] = next
      this.doc = { version: 1, exercises: this.doc.exercises, attempts }
      await this.persist()
      return next
    })
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.tail.then(job, job)
    this.tail = next.catch(() => {})
    return next
  }

  private async persist(): Promise<void> {
    const path = exerciseDocumentPath(this.root)
    const temp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
    try {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(temp, JSON.stringify(this.doc), 'utf8')
      await rename(temp, path)
    } catch {
      try {
        const text = await readFile(path, 'utf8')
        this.doc = sanitizeExerciseDocument(JSON.parse(text))
      } catch {
        this.doc = { version: 1, exercises: [], attempts: [] }
      }
      throw new Error('练习落盘失败')
    }
  }
}
