/**
 * 课程服务（实施-25 P07）：把「资料 / 主题 / 卡点」变成一门可调整的路线。
 *
 * 为什么单独一层：生成路线要读资料正文（宿主能力），而路线规则是纯函数。
 * 把两者放在 handler 里会让「单元指回的位置对不对」没法单测 —— 这里把
 * 依赖收成一个最小的 `LibraryReader` 接口，单测注入假资料即可钉住规则。
 *
 * **不调模型**：三条入口的骨架都由确定性规则生成（见 `shared/course.ts`），
 * 生成出来的补充单元一律带 `note` 说明「这是宿主规则，不是材料里的内容」。
 */
import {
  draftRouteFromText,
  makeUnitId,
  planBlockerUnits,
  planTopicUnits,
  validateUnit,
  type Course,
  type CourseInput,
  type CourseMutation,
  type LearningUnit
} from '../shared/course'
import type { SourceReference } from '../shared/library'
import { CourseStore, type NewUnitInput } from './course-store'

/** 服务需要的资料能力 —— 只要「按引用读正文」，不要一整个 LibraryService。 */
export interface LibraryReader {
  openRef(
    ref: SourceReference,
    options?: { maxChars?: number }
  ): Promise<{ outcome: string; text?: string; source?: { title?: string } }>
}

/**
 * 把一段正文登记成资料库来源。
 *
 * 成果不是资料库来源（两套 id 空间），所以「成果 → 学习材料」要先把它
 * 登记成一份 `text` 来源，之后的路线、出处、版本全部走既有那条路。
 * `ref` / `identity` 用 `artifact:<id>` —— 身份稳定，成果改了就是**新版本**。
 */
export interface LibraryImporter {
  importText(params: {
    ref: string
    identity: string
    title: string
    content: string
    spaceId?: string
    owner?: { kind: 'artifact'; id: string }
  }): Promise<{ ok: boolean; error?: string; sourceId?: string; version?: number }>
}

/** 读一份成果的当前版本正文（只读，不碰版本链）。 */
export interface ArtifactReader {
  read(artifactId: string): Promise<{ id: string; title: string; text: string; spaceId?: string } | null>
}

export interface CourseServiceOptions {
  store?: CourseStore
  library: LibraryReader
  artifacts?: ArtifactReader
  importer?: LibraryImporter
  random?: () => number
}

/** 生成路线时一次读入的正文上限（超了会截断，路线仍然可用）。 */
export const ROUTE_SOURCE_MAX_CHARS = 200_000

export class CourseService {
  readonly store: CourseStore
  private readonly library: LibraryReader
  private readonly artifacts?: ArtifactReader
  private readonly importer?: LibraryImporter
  private readonly random: () => number

  constructor(options: CourseServiceOptions) {
    this.store = options.store ?? new CourseStore()
    this.library = options.library
    this.artifacts = options.artifacts
    this.importer = options.importer
    this.random = options.random ?? Math.random
  }

  list(spaceId?: string | null): Course[] {
    return this.store.list(spaceId)
  }

  all(): Course[] {
    return this.store.all()
  }

  find(id: string): Course | undefined {
    return this.store.find(id)
  }

  private unitIdFactory(): () => string {
    const taken = new Set<string>()
    return () => makeUnitId((id) => taken.has(id), this.random)
  }

  /** 建课（可以先没有单元 —— 「先开始，边学边调整」）。 */
  async create(input: CourseInput): Promise<CourseMutation> {
    return this.store.create(input)
  }

  /**
   * 入口一：学这份资料。
   *
   * 读的是**指定的那一版**（不是最新版）：用户选的是「这份材料」，
   * 换版不该悄悄改掉路线指向的位置。
   */
  async createFromSource(params: {
    sourceId: string
    version: number
    input: CourseInput
    maxChars?: number
  }): Promise<CourseMutation> {
    const ref: SourceReference = { sourceId: params.sourceId, version: params.version }
    const opened = await this.library.openRef(ref, { maxChars: params.maxChars ?? ROUTE_SOURCE_MAX_CHARS })
    const text = opened.text ?? ''
    /*
     * 判据是「有没有正文」，不是 `outcome === 'ok'`：
     * 资料被软移除后，旧引用仍然要能读出旧版本正文（P03 的不变量）。
     */
    if (!text.trim()) {
      return {
        ok: false,
        reason: opened.outcome === 'removed' ? '这份资料已被移除，且这一版没有可读正文' : '这份资料没有可读正文（例如未解析成功的二进制文件）'
      }
    }

    const draft = draftRouteFromText(ref, text, {}, this.unitIdFactory())
    if (draft.units.length === 0) return { ok: false, reason: '这份资料切不出段落' }

    const input: CourseInput = {
      ...params.input,
      ...(params.input.entryInput ? {} : opened.source?.title ? { entryInput: opened.source.title } : {})
    }
    return this.store.create(input, draft.units, {
      basedOn: ref,
      ...(draft.truncated ? { truncated: true } : {})
    })
  }

  /**
   * 入口四（T06b-4）：成果「用于学习」。
   *
   * 先把成果正文登记成一份资料库来源，再走「学这份资料」那条完全相同的路 ——
   * 所以学习单元照样指得回**字符区间**，成果改了就开材料的新版本。
   *
   * 不在这里复制一套材料正文：材料就是成果那一段正文的快照。
   */
  async createFromArtifact(params: {
    artifactId: string
    input: CourseInput
    maxChars?: number
  }): Promise<CourseMutation> {
    if (!this.artifacts || !this.importer) {
      return { ok: false, reason: '宿主没有接入成果，暂时不能从成果生成路线' }
    }
    const doc = await this.artifacts.read(params.artifactId)
    if (!doc) return { ok: false, reason: '找不到这份成果' }
    if (!doc.text.trim()) return { ok: false, reason: '这份成果还没有正文，先写点内容再来学' }

    const imported = await this.importer.importText({
      ref: `artifact:${params.artifactId}`,
      identity: `text:artifact:${params.artifactId}`,
      title: `成果：${doc.title}`,
      content: doc.text,
      ...(params.input.spaceId ? { spaceId: params.input.spaceId } : {}),
      owner: { kind: 'artifact', id: params.artifactId }
    })
    if (!imported.ok || !imported.sourceId || !imported.version) {
      return { ok: false, reason: imported.error ?? '把成果转成学习材料失败' }
    }

    const input: CourseInput = {
      ...params.input,
      ...(params.input.entryInput ? {} : { entryInput: doc.title })
    }
    return this.createFromSource({
      sourceId: imported.sourceId,
      version: imported.version,
      input,
      ...(params.maxChars !== undefined ? { maxChars: params.maxChars } : {})
    })
  }

  /** 入口二：学会一个主题（没有材料出处，骨架标成补充）。 */
  async createFromTopic(input: CourseInput): Promise<CourseMutation> {
    const units = planTopicUnits(input.entryInput ?? input.title, input.minutesPerDay ?? 30, this.unitIdFactory())
    return this.store.create(input, units)
  }

  /** 入口三：我卡在这里（同上，骨架围绕卡点）。 */
  async createFromBlocker(input: CourseInput): Promise<CourseMutation> {
    const units = planBlockerUnits(input.entryInput ?? input.goal, input.minutesPerDay ?? 30, this.unitIdFactory())
    return this.store.create(input, units)
  }

  update(id: string, patch: { title?: unknown; goal?: unknown; level?: unknown; minutesPerDay?: unknown }): Promise<CourseMutation> {
    return this.store.update(id, patch)
  }

  /**
   * 插入单元。
   *
   * 校验交给 `validateUnit`：材料单元没有出处、补充单元没有说明都会被拒 ——
   * 这是「材料 vs 补充」这条边界在写入口上的落点。
   */
  async addUnit(id: string, input: NewUnitInput): Promise<CourseMutation> {
    const probe: LearningUnit = {
      id: 'u_probe',
      title: input.title,
      estimateMinutes: input.estimateMinutes ?? 30,
      origin: input.origin,
      sources: input.sources ?? [],
      concepts: input.concepts ?? [],
      ...(input.target ? { target: input.target } : {}),
      ...(input.note ? { note: input.note } : {})
    }
    const checked = validateUnit(probe)
    if (!checked.ok) return { ok: false, reason: checked.reason }
    return this.store.addUnit(id, { ...input, ...(input.estimateMinutes ? {} : { estimateMinutes: 30 }) })
  }

  updateUnit(
    id: string,
    unitId: string,
    patch: { title?: unknown; target?: unknown; estimateMinutes?: unknown; note?: unknown }
  ): Promise<CourseMutation> {
    return this.store.updateUnit(id, unitId, patch)
  }

  moveUnit(id: string, unitId: string, delta: number): Promise<CourseMutation> {
    return this.store.moveUnit(id, unitId, delta)
  }

  removeUnit(id: string, unitId: string): Promise<CourseMutation> {
    return this.store.removeUnit(id, unitId)
  }

  addConcept(id: string, name: unknown): Promise<CourseMutation> {
    return this.store.addConcept(id, name)
  }

  removeConcept(id: string, conceptId: string): Promise<CourseMutation> {
    return this.store.removeConcept(id, conceptId)
  }

  archive(id: string, archived = true): Promise<CourseMutation> {
    return this.store.archive(id, archived)
  }

  remove(id: string): Promise<{ ok: boolean; error?: string }> {
    return this.store.remove(id)
  }
}
