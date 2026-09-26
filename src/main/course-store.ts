/**
 * 课程与路线的存储（实施-25 P07）。
 *
 * 一份文档 `YAN_DIR/courses.json`：全部课程 + 它们的单元与概念。
 *
 * 与 `SpaceStore` / `ArtifactDocStore` 同一套做法：写队列串行、原子替换、读盘容错。
 * 课程的推进规则**不在这一层**：校验、生成路线、单元排序都在
 * `shared/course.ts` 的纯函数里。这里只负责「读回来 → 交给纯函数 → 写回去」。
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  addConcept,
  addUnit,
  createCourse,
  makeConceptId,
  makeCourseId,
  makeUnitId,
  moveUnit,
  removeConcept,
  removeUnit,
  sanitizeCourseDocument,
  updateCourse,
  updateUnit,
  MAX_COURSES,
  MAX_UNITS_PER_COURSE,
  type Concept,
  type Course,
  type CourseDocument,
  type CourseInput,
  type CourseMutation,
  type CourseSourceRef,
  type LearningUnit
} from '../shared/course'
import { YAN_DIR } from './paths'

export const COURSE_FILE_NAME = 'courses.json'

export function coursePath(root: string = YAN_DIR): string {
  return join(root, COURSE_FILE_NAME)
}

/** 新增单元的输入（id 由 store 生成，避免调用方自己编）。 */
export interface NewUnitInput {
  title: string
  target?: string
  estimateMinutes?: number
  origin: LearningUnit['origin']
  sources?: LearningUnit['sources']
  note?: string
  concepts?: string[]
}

export class CourseStore {
  private readonly root: string
  private readonly now: () => number
  private readonly random: () => number
  private doc: CourseDocument = { version: 1, courses: [] }
  private loaded = false
  private tail: Promise<unknown> = Promise.resolve()

  constructor(options: { root?: string; now?: () => number; random?: () => number } = {}) {
    this.root = options.root ?? YAN_DIR
    this.now = options.now ?? Date.now
    this.random = options.random ?? Math.random
  }

  async load(): Promise<void> {
    if (this.loaded) return
    try {
      this.doc = sanitizeCourseDocument(JSON.parse(await readFile(coursePath(this.root), 'utf8')))
    } catch {
      this.doc = { version: 1, courses: [] }
    }
    this.loaded = true
  }

  /** 全部课程（可选按空间过滤），最近更新的在前。调用前须 `load()`。 */
  list(spaceId?: string | null): Course[] {
    return this.doc.courses
      .filter((c) => (spaceId === undefined ? true : (c.spaceId ?? null) === spaceId))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  all(): Course[] {
    return this.doc.courses
  }

  find(id: string): Course | undefined {
    return this.doc.courses.find((c) => c.id === id)
  }

  private newCourseId(): string {
    return makeCourseId((id) => this.doc.courses.some((c) => c.id === id), this.random)
  }

  private newUnitId(course: Course): string {
    return makeUnitId((id) => course.units.some((u) => u.id === id), this.random)
  }

  private newConceptId(course: Course): string {
    return makeConceptId((id) => course.concepts.some((c) => c.id === id), this.random)
  }

  /**
   * 建课。`units` 用于「从资料 / 主题 / 卡点生成路线」的那一步 ——
   * 生成结果一次写入，避免「先建空课再补单元」中间态被用户看到；
   * `meta` 如实记下路线是从哪一版资料生成的、有没有被截断。
   */
  async create(
    input: CourseInput,
    units?: LearningUnit[],
    meta: { basedOn?: CourseSourceRef; truncated?: boolean } = {}
  ): Promise<CourseMutation> {
    return this.enqueue(async () => {
      await this.load()
      if (this.doc.courses.length >= MAX_COURSES) return { ok: false as const, reason: '课程太多了' }
      const created = createCourse(input, this.now(), () => this.newCourseId())
      if (!created.ok) return created
      const base =
        units && units.length ? { ...created.course, units: units.slice(0, MAX_UNITS_PER_COURSE) } : created.course
      const course: Course = {
        ...base,
        ...(meta.basedOn ? { basedOn: meta.basedOn } : {}),
        ...(meta.truncated ? { truncated: true } : {})
      }
      this.doc = { ...this.doc, courses: [...this.doc.courses, course] }
      await this.flush()
      return { ok: true as const, course }
    })
  }

  async update(
    id: string,
    patch: { title?: unknown; goal?: unknown; level?: unknown; minutesPerDay?: unknown }
  ): Promise<CourseMutation> {
    return this.mutate(id, (course) => updateCourse(course, patch, this.now()))
  }

  async addUnit(id: string, input: NewUnitInput): Promise<CourseMutation> {
    return this.mutate(id, (course) => {
      const unit: LearningUnit = {
        id: this.newUnitId(course),
        title: input.title,
        estimateMinutes: input.estimateMinutes ?? course.minutesPerDay,
        origin: input.origin,
        sources: input.sources ?? [],
        concepts: input.concepts ?? [],
        ...(input.target ? { target: input.target } : {}),
        ...(input.note ? { note: input.note } : {})
      }
      return addUnit(course, unit, this.now())
    })
  }

  async updateUnit(
    id: string,
    unitId: string,
    patch: { title?: unknown; target?: unknown; estimateMinutes?: unknown; note?: unknown }
  ): Promise<CourseMutation> {
    return this.mutate(id, (course) => updateUnit(course, unitId, patch, this.now()))
  }

  async moveUnit(id: string, unitId: string, delta: number): Promise<CourseMutation> {
    return this.mutate(id, (course) => moveUnit(course, unitId, delta, this.now()))
  }

  async removeUnit(id: string, unitId: string): Promise<CourseMutation> {
    return this.mutate(id, (course) => removeUnit(course, unitId, this.now()))
  }

  async addConcept(id: string, name: unknown): Promise<CourseMutation> {
    return this.mutate(id, (course) => addConcept(course, name, this.now(), () => this.newConceptId(course)))
  }

  async removeConcept(id: string, conceptId: string): Promise<CourseMutation> {
    return this.mutate(id, (course) => removeConcept(course, conceptId, this.now()))
  }

  /** 归档（课程不是正文，但删掉会让「学过什么」一起消失；先归档）。 */
  async archive(id: string, archived = true): Promise<CourseMutation> {
    return this.mutate(id, (course) => ({ ok: true, course: { ...course, status: archived ? 'archived' : 'active', updatedAt: this.now() } }))
  }

  /** 删除一门课（连同单元与概念）。 */
  async remove(id: string): Promise<{ ok: boolean; error?: string }> {
    return this.enqueue(async () => {
      await this.load()
      const next = this.doc.courses.filter((c) => c.id !== id)
      if (next.length === this.doc.courses.length) return { ok: false, error: '课程不存在' }
      this.doc = { ...this.doc, courses: next }
      await this.flush()
      return { ok: true }
    })
  }

  private async mutate(id: string, apply: (course: Course) => CourseMutation): Promise<CourseMutation> {
    return this.enqueue(async () => {
      await this.load()
      const current = this.find(id)
      if (!current) return { ok: false as const, reason: '找不到这门课程' }
      const result = apply(current)
      if (!result.ok) return result
      this.doc = { ...this.doc, courses: this.doc.courses.map((c) => (c.id === id ? result.course : c)) }
      await this.flush()
      return result
    })
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.tail.then(job, job)
    this.tail = run.catch(() => undefined)
    return run
  }

  private async flush(): Promise<void> {
    const target = coursePath(this.root)
    await mkdir(dirname(target), { recursive: true })
    const temp = `${target}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(this.doc), 'utf8')
    try {
      await rename(temp, target)
    } catch {
      await writeFile(target, JSON.stringify(this.doc), 'utf8')
      await rm(temp, { force: true }).catch(() => undefined)
    }
  }
}

/** 概念列表（IPC 形状用得到，避免调用方再翻一遍）。 */
export function conceptsOf(course: Course): Concept[] {
  return course.concepts
}
