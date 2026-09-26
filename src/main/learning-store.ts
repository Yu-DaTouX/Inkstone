/**
 * 学习状态的落盘（实施-25 P08）。
 *
 * 两份东西：
 *   ① **会话本体** `YAN_DIR/study-sessions.json` —— 阶段、位置、等待中的问题。
 *      它是**唯一事实源**：`waiting_for_learner` 从这里读，所以重开应用、
 *      换会话之后仍然成立（T08-2）。
 *   ② **闸门快照** `YAN_DIR/study-gate/<runnerId>.json` —— 给**薄层**看的每实例文件。
 *      本体按课程索引，而扩展只知道自己是个 runner（`YAN_SESSION_ID`），
 *      分不清哪条属于自己；与 `work-mode/<runnerId>.json` / `goal-resume/<runnerId>.json`
 *      同一个约定，文件名规则也共用同一个函数（两边不一致的后果是「闸门写了但没人看见」）。
 *
 * 落盘策略与其它 store 一致：写队列串行 + 临时文件原子替换 + 读盘容错。
 * 一致性上宁可**多拦一次**续跑（等待是真的），也不要因为一条坏记录把闸门漏掉。
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { YAN_DIR } from './paths'
import { workModeSnapshotFileName } from './work-mode-service'
import {
  findSessionForCourse,
  findSessionForRuntime,
  removeSession,
  sanitizeStudyDocument,
  upsertSession,
  type StudyDocument,
  type StudySession
} from '../shared/study'

export const STUDY_FILE_NAME = 'study-sessions.json'
export const STUDY_GATE_DIRNAME = 'study-gate'

export function studyDocumentPath(root: string = YAN_DIR): string {
  return join(root, STUDY_FILE_NAME)
}

/** 闸门文件名规则与 `work-mode` / `goal-resume` **共用**（改一处就是改三处，别各写一份）。 */
export function studyGatePath(runtimeKey: string, root: string = YAN_DIR): string {
  return join(root, STUDY_GATE_DIRNAME, workModeSnapshotFileName(runtimeKey))
}

/** 闸门内容：薄层只看 `waiting`，其余字段是排障与界面用的。 */
export interface StudyGate {
  version: 1
  waiting: boolean
  sessionId: string
  courseId: string
  unitId: string
  /** 「《课程》·第 3/12 节「标题」」，给日志与提示看。 */
  where: string
  at: number
}

export interface StudyStoreOptions {
  root?: string
}

export class StudyStore {
  private readonly root: string
  private doc: StudyDocument = { version: 1, sessions: [] }
  private loaded = false
  private tail: Promise<unknown> = Promise.resolve()

  constructor(options: StudyStoreOptions = {}) {
    this.root = options.root ?? YAN_DIR
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const text = await readFile(studyDocumentPath(this.root), 'utf8')
      this.doc = sanitizeStudyDocument(JSON.parse(text))
    } catch {
      this.doc = { version: 1, sessions: [] }
    }
  }

  snapshot(): StudyDocument {
    return { version: 1, sessions: [...this.doc.sessions] }
  }

  list(): StudySession[] {
    return [...this.doc.sessions]
  }

  find(id: string): StudySession | null {
    return this.doc.sessions.find((item) => item.id === id) ?? null
  }

  forCourse(courseId: string): StudySession | null {
    return findSessionForCourse(this.doc.sessions, courseId)
  }

  /**
   * 这个 pi 会话正在陪的课（闸门按它判）。
   *
   * 反查顺序有意写成「先按 runtimeKey 找」：一个会话同时只会陪一门课，
   * 换课程时先前的会话会把 `runtimeKey` 让出来（见 `save`）。
   */
  forRuntime(runtimeKey: string): StudySession | null {
    return findSessionForRuntime(this.doc.sessions, runtimeKey)
  }

  /**
   * 落一条会话（同一课程已有则替换；同一 pi 会话只能陪一门课）。
   *
   * 后一条很重要：用户在同一个会话里从 A 课切到 B 课时，A 课那条件也要保留
   * （他只是切走了，不是放弃），但它**不能再占着这个 runnerId** ——
   * 否则闸门按 runtimeKey 查会查到正在等待的 A 课，把 B 课的学习也拦住。
   */
  async save(session: StudySession): Promise<StudySession> {
    return this.enqueue(async () => {
      const cleaned = this.doc.sessions
        .filter((item) => item.courseId !== session.courseId || item.id === session.id)
        .map((item) =>
          item.runtimeKey && item.runtimeKey === session.runtimeKey && item.id !== session.id
            ? { ...item, runtimeKey: '' }
            : item
        )
      this.doc = { version: 1, sessions: upsertSession(cleaned, session) }
      await this.persist()
      return session
    })
  }

  async remove(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      if (!this.find(id)) return false
      this.doc = { version: 1, sessions: removeSession(this.doc.sessions, id) }
      await this.persist()
      return true
    })
  }

  /**
   * 写闸门快照（`gate = null` → 清掉）。
   *
   * 清闸门必须**真的删文件**：留着 `{waiting:false}` 与「没写过」在排障时要能分开，
   * 但薄层读的是「文件存在且 waiting === true」，两者都不会误拦。
   */
  async setGate(runtimeKey: string, gate: StudyGate | null): Promise<void> {
    return this.enqueue(async () => {
      const path = studyGatePath(runtimeKey, this.root)
      if (!gate) {
        await rm(path, { force: true }).catch(() => {})
        return
      }
      await mkdir(dirname(path), { recursive: true })
      const temp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
      await writeFile(temp, JSON.stringify(gate), 'utf8')
      await rename(temp, path)
    })
  }

  async readGate(runtimeKey: string): Promise<StudyGate | null> {
    try {
      const raw = JSON.parse(await readFile(studyGatePath(runtimeKey, this.root), 'utf8')) as Partial<StudyGate>
      if (raw?.waiting !== true) return null
      return {
        version: 1,
        waiting: true,
        sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : '',
        courseId: typeof raw.courseId === 'string' ? raw.courseId : '',
        unitId: typeof raw.unitId === 'string' ? raw.unitId : '',
        where: typeof raw.where === 'string' ? raw.where : '',
        at: typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : 0
      }
    } catch {
      return null
    }
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.tail.then(job, job)
    this.tail = next.catch(() => {})
    return next
  }

  private async persist(): Promise<void> {
    const path = studyDocumentPath(this.root)
    const temp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
    try {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(temp, JSON.stringify(this.doc), 'utf8')
      await rename(temp, path)
    } catch {
      try {
        const text = await readFile(path, 'utf8')
        this.doc = sanitizeStudyDocument(JSON.parse(text))
      } catch {
        this.doc = { version: 1, sessions: [] }
      }
      throw new Error('学习状态落盘失败')
    }
  }
}
