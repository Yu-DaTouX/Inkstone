/**
 * 办事模板的落盘（实施-25 P14）。
 *
 * 一份文档 `YAN_DIR/playbooks.json`。
 *
 * 三件事刻意做在这里、不做在服务层：
 *   · **写队列串行 + 临时文件原子替换 + 读盘容错**（与其它 store 同一套）；
 *   · **坏模板整份丢掉**：`sanitizePlaybook` 读不出步骤（例如旧数据里有写步骤却
 *     没有范围）就丢掉它 —— 留着一条「不知道会动哪里的写操作」比丢掉危险得多；
 *   · **起步模板不落盘**：这份文档里只有用户真的存过的东西。
 *     三个起步模板由 `withSeedPlaybooks` 在读取时合进来（同 id 以落盘的为准）。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { YAN_DIR } from './paths'
import {
  emptyPlaybookDocument,
  findPlaybook,
  removePlaybookFrom,
  removeSpacePlaybooksFrom,
  sanitizePlaybookDocument,
  upsertPlaybookIn,
  withSeedPlaybooks,
  type Playbook,
  type PlaybookDocument
} from '../shared/playbook'

export const PLAYBOOK_FILE_NAME = 'playbooks.json'

export function playbookPath(root: string = YAN_DIR): string {
  return join(root, PLAYBOOK_FILE_NAME)
}

export interface PlaybookStoreOptions {
  root?: string
}

export class PlaybookStore {
  private readonly root: string
  private doc: PlaybookDocument = emptyPlaybookDocument()
  private loaded = false
  private tail: Promise<unknown> = Promise.resolve()

  constructor(options: PlaybookStoreOptions = {}) {
    this.root = options.root ?? YAN_DIR
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const text = await readFile(playbookPath(this.root), 'utf8')
      this.doc = sanitizePlaybookDocument(JSON.parse(text))
    } catch {
      this.doc = emptyPlaybookDocument()
    }
  }

  /** 落盘的那一份（不含起步模板）。 */
  snapshot(): PlaybookDocument {
    return { version: 1, playbooks: [...this.doc.playbooks] }
  }

  /** 列表（含起步模板 + 可选按空间过滤）。 */
  list(spaceId?: string | null, now = Date.now()): Playbook[] {
    const all = withSeedPlaybooks(this.doc, now)
    if (!spaceId) return all
    return all.filter((p) => !p.spaceId || p.spaceId === spaceId)
  }

  find(id: string, now = Date.now()): Playbook | null {
    /* 先查落盘的，再查起步模板 —— 用户改过的种子会以落盘版本出现 */
    return findPlaybook(this.doc, id) ?? withSeedPlaybooks(this.doc, now).find((p) => p.id === id) ?? null
  }

  async save(playbook: Playbook): Promise<Playbook> {
    return this.enqueue(async () => {
      this.doc = upsertPlaybookIn(this.doc, playbook)
      await this.persist()
      return playbook
    })
  }

  async remove(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      if (!findPlaybook(this.doc, id)) return false
      this.doc = removePlaybookFrom(this.doc, id)
      await this.persist()
      return true
    })
  }

  /** 删空间时带走属于它的模板（不挑空间的模板留着）。 */
  async removeSpace(spaceId: string): Promise<number> {
    return this.enqueue(async () => {
      const { doc, removed } = removeSpacePlaybooksFrom(this.doc, spaceId)
      if (removed > 0) {
        this.doc = doc
        await this.persist()
      }
      return removed
    })
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.tail.then(job, job)
    this.tail = next.catch(() => {})
    return next
  }

  private async persist(): Promise<void> {
    const path = playbookPath(this.root)
    const temp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
    try {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(temp, JSON.stringify(this.doc), 'utf8')
      await rename(temp, path)
    } catch {
      try {
        const text = await readFile(path, 'utf8')
        this.doc = sanitizePlaybookDocument(JSON.parse(text))
      } catch {
        this.doc = emptyPlaybookDocument()
      }
      throw new Error('办事模板落盘失败')
    }
  }
}
