/**
 * 可编辑成果的存储（实施-25 P06a）。
 *
 * 一份文档 `YAN_DIR/artifact-docs.json`：全部成果 + 它们的版本历史。
 *
 * 与 `LibraryStore` / `SpaceStore` 同一套做法：写队列串行、原子替换、读盘容错。
 * 版本的推进规则**不在这一层**：它是 `shared/artifact-doc.ts` 的纯函数
 *（`applyUserEdit` / `applyAgentEdit`）。这里只负责「读回来 → 交给纯函数 →
 * 写回去」，所以「用户编辑不被覆盖」可以被单测钉死，而不依赖磁盘行为。
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  addArtifactSource,
  applyAgentEdit,
  applyUserEdit,
  assignArtifact,
  createArtifactDoc,
  currentTextOf,
  makeArtifactId,
  renameArtifact,
  renderArtifactMarkdown,
  sanitizeArtifactDocument,
  toggleChecklistItem,
  type AgentEditInput,
  type ArtifactDoc,
  type ArtifactDocument,
  type ArtifactExportSource,
  type ArtifactMutation,
  type ArtifactSourceRef,
  type CreateArtifactInput
} from '../shared/artifact-doc'
import { YAN_DIR } from './paths'

export const ARTIFACT_DOC_FILE_NAME = 'artifact-docs.json'

export function artifactDocPath(root: string = YAN_DIR): string {
  return join(root, ARTIFACT_DOC_FILE_NAME)
}

export class ArtifactDocStore {
  private readonly root: string
  private readonly now: () => number
  private readonly random: () => number
  private doc: ArtifactDocument = { version: 1, docs: [] }
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
      this.doc = sanitizeArtifactDocument(JSON.parse(await readFile(artifactDocPath(this.root), 'utf8')))
    } catch {
      this.doc = { version: 1, docs: [] }
    }
    this.loaded = true
  }

  /** 全部成果（可选按空间过滤），最近更新的在前。调用前须 `load()`。 */
  list(spaceId?: string | null): ArtifactDoc[] {
    return this.doc.docs
      .filter((d) => (spaceId === undefined ? true : (d.spaceId ?? null) === spaceId))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  find(id: string): ArtifactDoc | undefined {
    return this.doc.docs.find((d) => d.id === id)
  }

  async create(input: CreateArtifactInput): Promise<ArtifactMutation> {
    return this.mutate(() => createArtifactDoc(input, this.now(), (taken) => makeArtifactId(taken, this.random)))
  }

  async saveUserEdit(id: string, text: unknown): Promise<ArtifactMutation> {
    return this.mutate((current) => applyUserEdit(current, text, this.now()), id)
  }

  async applyAgentEdit(id: string, input: AgentEditInput): Promise<ArtifactMutation> {
    return this.mutate((current) => applyAgentEdit(current, input, this.now()), id)
  }

  async rename(id: string, title: unknown): Promise<ArtifactMutation> {
    return this.mutate((current) => renameArtifact(current, title, this.now()), id)
  }

  async assign(id: string, patch: { spaceId?: string | null; taskId?: string | null }): Promise<ArtifactMutation> {
    return this.mutate((current) => assignArtifact(current, patch, this.now()), id)
  }

  async addSource(id: string, ref: ArtifactSourceRef): Promise<ArtifactMutation> {
    return this.mutate((current) => addArtifactSource(current, ref, this.now()), id)
  }

  /**
   * 勾选 / 取消勾选结构化清单的一项（T06b-1）。
   *
   * 走 `applyUserEdit` 而不是直接改文本：**勾选就是一次用户编辑**，应开新版本、
   * 进 `userEditedParagraphs`（agent 之后整篇重写时不会把用户的勾选抹掉）。
   */
  async toggleChecklist(id: string, index: number): Promise<ArtifactMutation> {
    return this.mutate((current) => {
      const toggled = toggleChecklistItem(currentTextOf(current), index)
      if (!toggled.ok) return { ok: false as const, reason: toggled.reason }
      return applyUserEdit(current, toggled.text, this.now())
    }, id)
  }

  /**
   * 导出用的 Markdown（T06b-3）。
   *
   * 同步读当前内存态（导出前须 `load()`）。来源标题由调用方传入 ——
   * 成果只存 `{sourceId, version}`，标题去资料库取，不在这里复制一份。
   */
  markdownOf(
    id: string,
    sources: readonly ArtifactExportSource[] = []
  ): { ok: true; markdown: string } | { ok: false; reason: string } {
    const doc = this.find(id)
    if (!doc) return { ok: false, reason: '找不到这份成果' }
    return { ok: true, markdown: renderArtifactMarkdown(doc, sources) }
  }

  /** 删除一份成果（与空间相反：成果是用户的正文，允许物理删除）。 */
  async remove(id: string): Promise<{ ok: boolean; error?: string }> {
    return this.enqueue(async () => {
      await this.load()
      const next = this.doc.docs.filter((d) => d.id !== id)
      if (next.length === this.doc.docs.length) return { ok: false, error: '成果不存在' }
      this.doc = { ...this.doc, docs: next }
      await this.flush()
      return { ok: true }
    })
  }

  private async mutate(
    apply: (current: ArtifactDoc) => ArtifactMutation,
    id?: string
  ): Promise<ArtifactMutation> {
    return this.enqueue(async () => {
      await this.load()
      const current = id ? this.find(id) : undefined
      if (id && !current) return { ok: false as const, reason: '找不到这份成果' }
      const result = apply(current as ArtifactDoc)
      if (!result.ok) return result

      const docs = id
        ? this.doc.docs.map((d) => (d.id === id ? result.doc : d))
        : [...this.doc.docs, result.doc]
      this.doc = { ...this.doc, docs }
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
    const target = artifactDocPath(this.root)
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
