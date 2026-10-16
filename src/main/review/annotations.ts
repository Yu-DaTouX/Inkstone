/**
 * 评审批注存储（§10.2 / WP-50）。
 *
 * ── 职责 ──
 * 每个**变更集**一份文档：`<root>/review/annotations/<changeSetId>.json`。
 * 批注是用户对代码的旁注，与 pi 会话文件、运行历史都分开存，谁也不覆盖谁。
 *
 * ── 四条硬边界（对应任务要求）──
 *   1. **原子串行**：同一变更集的读改写走一条 Promise 队列，落盘用
 *      `writeFileDurable`（`wx` + fsync）+ rename；写盘成功后才提交内存，
 *      失败时内存不会先出现一条「其实没持久化」的批注。
 *   2. **scope / 目录校验**：文档一旦建立就记住 `scopeKey`；后续写入带不同
 *      scopeKey 一律拒绝。目录由调用方注入固定 root，文件名只由 changeSetId
 *      派生（再过滤字符集），渲染端传不了路径。
 *   3. **迟到写防错归属**：scopeKey 是归属凭证 —— 会话 / 基准换了而异步写入
 *      才回来时，旧 scopeKey 会被拒；调用方据此把结果只更新到发起时的那份
 *      变更集上。
 *   4. **体积 / 行号上限**：正文、批注条数、文档字节数都在写入前校验
 *      （见 `shared/review.ts`），任何一条超限都 fail closed。
 */
import { mkdir, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parsePersistedDocument } from '../persisted-document'
import { writeFileDurable } from '../write-file-durable'
import { YAN_DIR } from '../paths'
import {
  REVIEW_MAX_ANNOTATION_BYTES,
  REVIEW_MAX_ANNOTATIONS,
  validateAnnotationInput,
  type ReviewAnnotation,
  type ReviewAnnotationDocument,
  type ReviewAnnotationInput,
  type ReviewAnnotationPatch,
  type ReviewAnnotationResult
} from '../../shared/review'

export interface ReviewAnnotationStoreOptions {
  /** 数据根目录；缺省 `YAN_DIR`。批注落在 `<root>/review/annotations/`。 */
  root?: string
  now?: () => number
  /** 注入 id 生成（测试用）；缺省时间 + 序号 */
  newId?: () => string
  /** 注入落盘实现（测试用）；缺省临时文件 + fsync + rename */
  write?: (path: string, text: string) => Promise<void>
}

const ANNOTATIONS_DIRNAME = 'review'
const ANNOTATIONS_SUBDIR = 'annotations'
const ID_SAFE = /^[A-Za-z0-9._-]+$/

let idSeq = 0

/** 变更集 id → 安全文件名；非法字符一律拒绝，不猜用户意图。 */
export function annotationFileName(changeSetId: string): string | null {
  const id = String(changeSetId ?? '').trim()
  if (!id || id.length > 200 || !ID_SAFE.test(id)) return null
  return `${id}.json`
}

export function annotationsDir(root: string = YAN_DIR): string {
  return join(root, ANNOTATIONS_DIRNAME, ANNOTATIONS_SUBDIR)
}

function sanitizeAnnotation(raw: unknown, changeSetId: string): ReviewAnnotation | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const path = typeof o.path === 'string' ? o.path : ''
  const body = typeof o.body === 'string' ? o.body : ''
  const id = typeof o.id === 'string' ? o.id : ''
  if (!id || !path || !body) return null
  const lineStart = Math.trunc(Number(o.lineStart))
  const lineEnd = Math.trunc(Number(o.lineEnd ?? o.lineStart))
  if (!Number.isFinite(lineStart) || !Number.isFinite(lineEnd) || lineStart < 1 || lineEnd < lineStart) return null
  const side = o.side === 'old' || o.side === 'file' ? o.side : 'new'
  return {
    id: id.slice(0, 200),
    changeSetId,
    path: path.slice(0, 4_096),
    side,
    lineStart,
    lineEnd,
    body: body.slice(0, 8_000),
    anchorRevision: typeof o.anchorRevision === 'string' ? o.anchorRevision.slice(0, 200) : '',
    createdAt: Number.isFinite(o.createdAt) ? Number(o.createdAt) : 0,
    updatedAt: Number.isFinite(o.updatedAt) ? Number(o.updatedAt) : 0,
    author: o.author === 'agent' ? 'agent' : 'user'
  }
}

/** 读盘容错：坏条目丢掉，不因一份坏文档丢掉整份批注。 */
export function sanitizeAnnotationDocument(raw: unknown, changeSetId: string): ReviewAnnotationDocument {
  const source = raw && typeof raw === 'object' ? (raw as Partial<ReviewAnnotationDocument>) : {}
  const seen = new Set<string>()
  const annotations: ReviewAnnotation[] = []
  for (const item of Array.isArray(source.annotations) ? source.annotations : []) {
    const entry = sanitizeAnnotation(item, changeSetId)
    if (!entry || seen.has(entry.id)) continue
    seen.add(entry.id)
    annotations.push(entry)
  }
  return {
    version: 1,
    changeSetId,
    scopeKey: typeof source.scopeKey === 'string' ? source.scopeKey.slice(0, 1_000) : '',
    revision: Number.isFinite(source.revision) ? Math.max(0, Math.trunc(Number(source.revision))) : 0,
    annotations
  }
}

function emptyResult(error: string): ReviewAnnotationResult {
  return { ok: false, error }
}

export class ReviewAnnotationStore {
  private readonly root: string
  private readonly now: () => number
  private readonly newId: () => string
  private readonly write?: (path: string, text: string) => Promise<void>
  /** changeSetId → 已提交内存的文档 */
  private readonly docs = new Map<string, ReviewAnnotationDocument>()
  /** changeSetId → 串行队列尾 */
  private readonly tails = new Map<string, Promise<unknown>>()

  constructor(options: ReviewAnnotationStoreOptions = {}) {
    this.root = options.root ?? YAN_DIR
    this.now = options.now ?? Date.now
    this.newId =
      options.newId ??
      (() => {
        idSeq += 1
        return `a-${Date.now().toString(36)}-${idSeq.toString(36)}`
      })
    this.write = options.write
  }

  private target(changeSetId: string): string | null {
    const name = annotationFileName(changeSetId)
    return name ? join(annotationsDir(this.root), name) : null
  }

  /** 读一份文档（先看内存，再看盘）。读盘失败时抛错，调用方据此 fail closed。 */
  private async load(changeSetId: string): Promise<ReviewAnnotationDocument> {
    const cached = this.docs.get(changeSetId)
    if (cached) return cached
    const target = this.target(changeSetId)
    if (!target) throw new Error('变更集 id 不合法')
    try {
      const text = await readFile(target, 'utf8')
      const parsed = parsePersistedDocument(text, { annotations: 'array' })
      const doc = sanitizeAnnotationDocument(parsed, changeSetId)
      this.docs.set(changeSetId, doc)
      return doc
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const doc: ReviewAnnotationDocument = { version: 1, changeSetId, scopeKey: '', revision: 0, annotations: [] }
        this.docs.set(changeSetId, doc)
        return doc
      }
      throw new Error('批注文件读取或解析失败，已拒绝覆盖', { cause: error })
    }
  }

  private enqueue<T>(changeSetId: string, job: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(changeSetId) ?? Promise.resolve()
    const run = prev.then(job, job)
    this.tails.set(
      changeSetId,
      run.then(
        () => undefined,
        () => undefined
      )
    )
    return run
  }

  private async flush(changeSetId: string, candidate: ReviewAnnotationDocument): Promise<void> {
    const target = this.target(changeSetId)
    if (!target) throw new Error('变更集 id 不合法')
    const payload = JSON.stringify(candidate, null, 2)
    if (Buffer.byteLength(payload, 'utf8') > REVIEW_MAX_ANNOTATION_BYTES) {
      throw new Error(`批注文档超过 ${REVIEW_MAX_ANNOTATION_BYTES} 字节上限`)
    }
    const temp = `${target}.${process.pid}.tmp`
    await mkdir(dirname(target), { recursive: true })
    if (this.write) {
      await this.write(temp, payload)
    } else {
      await writeFileDurable(temp, payload)
    }
    try {
      await rename(temp, target)
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
  }

  /**
   * 校验 scopeKey 是否与文档一致。
   *
   * 文档为空（还没写过）时以调用方给的 scopeKey 为准；文档已有 scopeKey
   * 且不同则拒绝 —— 这正是「迟到写防错归属」的落点。
   */
  private checkScope(doc: ReviewAnnotationDocument, scopeKey: string): string | null {
    if (!doc.scopeKey) return null
    if (doc.scopeKey !== scopeKey) return '变更集归属已变化，这次写入被丢弃'
    return null
  }

  async list(
    changeSetId: string,
    scopeKey: string
  ): Promise<{ ok: boolean; error?: string; annotations: ReviewAnnotation[]; revision: number }> {
    try {
      const doc = await this.load(changeSetId)
      if (doc.scopeKey && doc.scopeKey !== scopeKey) {
        return { ok: false, error: '变更集归属不匹配', annotations: [], revision: doc.revision }
      }
      return { ok: true, annotations: [...doc.annotations], revision: doc.revision }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), annotations: [], revision: 0 }
    }
  }

  /** 各文件已存在的批注数；供变更集列表合并。读失败时返回空表，不抛。 */
  async countsByPath(changeSetId: string, scopeKey: string): Promise<Map<string, number>> {
    const result = await this.list(changeSetId, scopeKey)
    const counts = new Map<string, number>()
    if (!result.ok) return counts
    for (const annotation of result.annotations) counts.set(annotation.path, (counts.get(annotation.path) ?? 0) + 1)
    return counts
  }

  create(input: ReviewAnnotationInput): Promise<ReviewAnnotationResult> {
    const validated = validateAnnotationInput(input)
    if (!validated.ok) return Promise.resolve(emptyResult(validated.error))
    const value = validated.value
    return this.enqueue(value.changeSetId, async () => {
      const doc = await this.load(value.changeSetId)
      const scopeError = this.checkScope(doc, value.scopeKey)
      if (scopeError) return emptyResult(scopeError)
      if (doc.annotations.length >= REVIEW_MAX_ANNOTATIONS) {
        return emptyResult(`批注数量已达上限（${REVIEW_MAX_ANNOTATIONS}）`)
      }
      const at = this.now()
      const annotation: ReviewAnnotation = {
        id: this.newId(),
        changeSetId: value.changeSetId,
        path: value.path,
        side: value.side ?? 'new',
        lineStart: value.lineStart,
        lineEnd: value.lineEnd ?? value.lineStart,
        body: value.body,
        anchorRevision: value.anchorRevision ?? '',
        createdAt: at,
        updatedAt: at,
        author: value.author ?? 'user'
      }
      const candidate: ReviewAnnotationDocument = {
        version: 1,
        changeSetId: doc.changeSetId,
        scopeKey: doc.scopeKey || value.scopeKey,
        revision: doc.revision + 1,
        annotations: [...doc.annotations, annotation]
      }
      try {
        await this.flush(value.changeSetId, candidate)
      } catch (error) {
        return emptyResult(error instanceof Error ? error.message : String(error))
      }
      this.docs.set(value.changeSetId, candidate)
      return { ok: true, revision: candidate.revision, annotation }
    })
  }

  update(
    changeSetId: string,
    scopeKey: string,
    id: string,
    patch: ReviewAnnotationPatch
  ): Promise<ReviewAnnotationResult> {
    const targetId = String(id ?? '').trim()
    return this.enqueue(changeSetId, async () => {
      const doc = await this.load(changeSetId)
      const scopeError = this.checkScope(doc, scopeKey)
      if (scopeError) return emptyResult(scopeError)
      const index = doc.annotations.findIndex((annotation) => annotation.id === targetId)
      if (index < 0) return emptyResult('批注不存在')

      const current = doc.annotations[index]
      const body = patch.body === undefined ? current.body : String(patch.body).trim()
      if (!body) return emptyResult('批注内容不能为空')
      if (body.length > 8_000) return emptyResult('批注内容过长')
      const side = patch.side === 'old' || patch.side === 'file' ? patch.side : current.side
      const lineStart = patch.lineStart === undefined ? current.lineStart : Math.trunc(Number(patch.lineStart))
      const lineEnd = patch.lineEnd === undefined ? current.lineEnd : Math.trunc(Number(patch.lineEnd))
      if (!Number.isFinite(lineStart) || !Number.isFinite(lineEnd) || lineStart < 1 || lineEnd < lineStart) {
        return emptyResult('行号不合法')
      }
      const updated: ReviewAnnotation = { ...current, body, side, lineStart, lineEnd, updatedAt: this.now() }
      const annotations = [...doc.annotations]
      annotations[index] = updated
      const candidate: ReviewAnnotationDocument = { ...doc, revision: doc.revision + 1, annotations }
      try {
        await this.flush(changeSetId, candidate)
      } catch (error) {
        return emptyResult(error instanceof Error ? error.message : String(error))
      }
      this.docs.set(changeSetId, candidate)
      return { ok: true, revision: candidate.revision, annotation: updated }
    })
  }

  remove(changeSetId: string, scopeKey: string, id: string): Promise<ReviewAnnotationResult> {
    const targetId = String(id ?? '').trim()
    return this.enqueue(changeSetId, async () => {
      const doc = await this.load(changeSetId)
      const scopeError = this.checkScope(doc, scopeKey)
      if (scopeError) return emptyResult(scopeError)
      const annotations = doc.annotations.filter((annotation) => annotation.id !== targetId)
      if (annotations.length === doc.annotations.length) return emptyResult('批注不存在')
      const candidate: ReviewAnnotationDocument = { ...doc, revision: doc.revision + 1, annotations }
      try {
        await this.flush(changeSetId, candidate)
      } catch (error) {
        return emptyResult(error instanceof Error ? error.message : String(error))
      }
      this.docs.set(changeSetId, candidate)
      return { ok: true, revision: candidate.revision }
    })
  }

  clear(changeSetId: string, scopeKey: string): Promise<ReviewAnnotationResult> {
    return this.enqueue(changeSetId, async () => {
      const doc = await this.load(changeSetId)
      const scopeError = this.checkScope(doc, scopeKey)
      if (scopeError) return emptyResult(scopeError)
      const candidate: ReviewAnnotationDocument = { ...doc, revision: doc.revision + 1, annotations: [] }
      try {
        await this.flush(changeSetId, candidate)
      } catch (error) {
        return emptyResult(error instanceof Error ? error.message : String(error))
      }
      this.docs.set(changeSetId, candidate)
      return { ok: true, revision: candidate.revision }
    })
  }

  /** 等待所有已排队的写入落盘（测试 / 退出收尾）。 */
  async whenIdle(): Promise<void> {
    await Promise.allSettled([...this.tails.values()])
  }
}
