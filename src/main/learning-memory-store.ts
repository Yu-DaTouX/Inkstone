/**
 * 学习记忆的落盘（实施-25 P11）：笔记与概念进度。
 *
 * 一份文档 `YAN_DIR/learning-memory.json`，同时装 `notes` 与 `progress`：
 *   · 两者都按课程归属，生命周期也绑在一起（删课程要一起收拾）；
 *   · `progress` 的唯一写入口是服务层的「用证据重算」（见 `shared/learning-memory.ts`），
 *     存储层不做任何判定 —— 所以「两条轴怎么变」只有一处规则。
 *
 * 与 `study-sessions.json` 分开是因为职责不同：那份是「正在进行的学习」
 * （阶段 / 位置 / 闸门），这份是「学完之后留下什么」（笔记 / 观察）。
 * 混在一起会让每次阶段推进都去重写一份可能很大的笔记文档。
 *
 * 落盘策略与其它 store 一致：写队列串行 + 临时文件原子替换 + 读盘容错。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { YAN_DIR } from './paths'
import {
  findProgress,
  notesForCourse,
  progressForCourse,
  sanitizeLearningMemoryDocument,
  upsertNoteIn,
  type ConceptProgress,
  type LearningMemoryDocument,
  type LearningNote
} from '../shared/learning-memory'
import { reviewsForCourse, upsertReviewIn, type ReviewItem } from '../shared/review'

export const LEARNING_MEMORY_FILE_NAME = 'learning-memory.json'

export function learningMemoryPath(root: string = YAN_DIR): string {
  return join(root, LEARNING_MEMORY_FILE_NAME)
}

export interface LearningMemoryStoreOptions {
  root?: string
}

export class LearningMemoryStore {
  private readonly root: string
  private doc: LearningMemoryDocument = { version: 1, notes: [], progress: [], reviews: [] }
  private loaded = false
  private tail: Promise<unknown> = Promise.resolve()

  constructor(options: LearningMemoryStoreOptions = {}) {
    this.root = options.root ?? YAN_DIR
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const text = await readFile(learningMemoryPath(this.root), 'utf8')
      this.doc = sanitizeLearningMemoryDocument(JSON.parse(text))
    } catch {
      this.doc = { version: 1, notes: [], progress: [], reviews: [] }
    }
  }

  snapshot(): LearningMemoryDocument {
    return {
      version: 1,
      notes: [...this.doc.notes],
      progress: [...this.doc.progress],
      reviews: [...this.doc.reviews]
    }
  }

  notes(courseId?: string): LearningNote[] {
    return courseId ? notesForCourse(this.doc.notes, courseId) : [...this.doc.notes]
  }

  findNote(id: string): LearningNote | null {
    return this.doc.notes.find((item) => item.id === id) ?? null
  }

  progress(courseId?: string): ConceptProgress[] {
    return courseId ? progressForCourse(this.doc.progress, courseId) : [...this.doc.progress]
  }

  findProgress(courseId: string, conceptId: string): ConceptProgress | null {
    return findProgress(this.doc.progress, courseId, conceptId)
  }

  async saveNote(note: LearningNote): Promise<LearningNote> {
    return this.enqueue(async () => {
      this.doc = {
        version: 1,
        notes: upsertNoteIn(this.doc.notes, note),
        progress: this.doc.progress,
        reviews: this.doc.reviews
      }
      await this.persist()
      return note
    })
  }

  async removeNote(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      if (!this.findNote(id)) return false
      this.doc = {
        version: 1,
        notes: this.doc.notes.filter((item) => item.id !== id),
        progress: this.doc.progress,
        reviews: this.doc.reviews
      }
      await this.persist()
      return true
    })
  }

  /* ---- 错题与复习（P12）：与笔记 / 进度同一份文档、同一门课程 ---- */

  reviews(courseId?: string): ReviewItem[] {
    return courseId ? reviewsForCourse(this.doc.reviews, courseId) : [...this.doc.reviews]
  }

  findReview(id: string): ReviewItem | null {
    return this.doc.reviews.find((item) => item.id === id) ?? null
  }

  /** 落一条复习项：同**概念**只有一条（新的覆盖旧的）。 */
  async saveReview(review: ReviewItem): Promise<ReviewItem> {
    return this.enqueue(async () => {
      this.doc = {
        version: 1,
        notes: this.doc.notes,
        progress: this.doc.progress,
        reviews: upsertReviewIn(this.doc.reviews, review)
      }
      await this.persist()
      return review
    })
  }

  async removeReview(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      const before = this.doc.reviews.length
      this.doc = {
        version: 1,
        notes: this.doc.notes,
        progress: this.doc.progress,
        reviews: this.doc.reviews.filter((item) => item.id !== id)
      }
      if (before === this.doc.reviews.length) return false
      await this.persist()
      return true
    })
  }

  /** 落一条概念进度（同 `courseId + conceptId` 替换 —— 每个概念只有一条摘要）。 */
  async saveProgress(progress: ConceptProgress): Promise<ConceptProgress> {
    return this.enqueue(async () => {
      const rest = this.doc.progress.filter(
        (item) => !(item.courseId === progress.courseId && item.conceptId === progress.conceptId)
      )
      this.doc = {
        version: 1,
        notes: this.doc.notes,
        progress: [...rest, progress],
        reviews: this.doc.reviews
      }
      await this.persist()
      return progress
    })
  }

  async removeConcept(courseId: string, conceptId: string): Promise<boolean> {
    return this.enqueue(async () => {
      const before = this.doc.progress.length
      this.doc = {
        version: 1,
        notes: this.doc.notes,
        progress: this.doc.progress.filter((item) => !(item.courseId === courseId && item.conceptId === conceptId)),
        reviews: this.doc.reviews
      }
      const removed = before - this.doc.progress.length
      if (removed > 0) await this.persist()
      return removed > 0
    })
  }

  /** 删一门课的笔记、进度与复习项（课程被删时一并收拾）。 */
  async removeCourse(courseId: string): Promise<{ notes: number; progress: number; reviews: number }> {
    return this.enqueue(async () => {
      const before = { notes: this.doc.notes.length, progress: this.doc.progress.length, reviews: this.doc.reviews.length }
      this.doc = {
        version: 1,
        notes: this.doc.notes.filter((item) => item.courseId !== courseId),
        progress: this.doc.progress.filter((item) => item.courseId !== courseId),
        reviews: this.doc.reviews.filter((item) => item.courseId !== courseId)
      }
      const removed = {
        notes: before.notes - this.doc.notes.length,
        progress: before.progress - this.doc.progress.length,
        reviews: before.reviews - this.doc.reviews.length
      }
      if (removed.notes > 0 || removed.progress > 0 || removed.reviews > 0) await this.persist()
      return removed
    })
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.tail.then(job, job)
    this.tail = next.catch(() => {})
    return next
  }

  private async persist(): Promise<void> {
    const path = learningMemoryPath(this.root)
    const temp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
    try {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(temp, JSON.stringify(this.doc), 'utf8')
      await rename(temp, path)
    } catch {
      try {
        const text = await readFile(path, 'utf8')
        this.doc = sanitizeLearningMemoryDocument(JSON.parse(text))
      } catch {
        this.doc = { version: 1, notes: [], progress: [], reviews: [] }
      }
      throw new Error('学习记忆落盘失败')
    }
  }
}
