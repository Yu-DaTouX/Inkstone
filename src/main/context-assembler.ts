/**
 * 上下文装配器（实施-25 P05 / T05-3）—— 宿主侧的唯一读盘实现。
 *
 * `shared/context-assembly.ts` 负责**怎么装**（纯函数、预算、引用标注）；
 * 这里负责**装什么**：从资料库取本会话引用的片段、从宿主传入任务与偏好摘要，
 * 然后把渲染好的分区写进扩展读的快照。
 *
 * ══════════════════════════════════════════════════════════════════
 * 三条边界
 * ══════════════════════════════════════════════════════════════════
 * 1. **只读引用，不重新检索**：片段来自会话已登记的 `{ sourceId, version }`
 *    引用（资料库是唯一事实源）。没有语义检索能力时，就如实取正文开头一段，
 *    不假装它是「与问题最相关的段落」——假装会让用户以为引用是挑过的。
 * 2. **不读当前前台导航**：会话 id / 空间 id 由调用方按会话传入，
 *    切会话不串（与 `AgentProfile` 同一条边界）。
 * 3. **写盘与资料库解耦**：扩展只认 `agent-context/<runtimeKey>.json`，
 *    与 `agent-profile/<runtimeKey>.json` 同一交接方式 —— 扩展不读资料库文档。
 *
 * 快照写失败**不抛给调用方**（`assembleAndWrite` 里 catch）：上下文是增强，
 * 读不到资料不应该拦着一轮对话开始。这一点与「档案快照」不同 ——
 * 档案决定角色，静默失效会让日常退回代码助手（不可接受）。
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AgentActivity } from '../shared/agent-profile'
import { assembleContext, renderContextSection, type ContextAssembly } from '../shared/context-assembly'
import { refReadable, refsForOwner } from '../shared/library'
import { LibraryService } from './library-service'
import { YAN_DIR } from './paths'

export const CONTEXT_SNAPSHOT_DIRNAME = 'agent-context'
/** 单条来源最多带多少字符（其余由预算层再裁）。 */
export const DEFAULT_MAX_SOURCE_CHARS = 1200
/** 一次最多带几条来源（与设计稿「少量偏好、必要片段」一致）。 */
export const DEFAULT_MAX_SOURCES = 3

export interface AssembleContextRequest {
  activity: AgentActivity
  /** 会话 id（资料库引用的 owner id）。缺省 = 这个会话还没有引用。 */
  sessionId?: string
  requirement?: string
  /** 任务 / 学习阶段摘要（调用方从 goal / task-plan 取好）。 */
  task?: string
  /** 空间知识摘要。 */
  space?: string
  preference?: string
  budget?: number
  maxSourceChars?: number
  maxSources?: number
}

export function contextSnapshotFileName(runtimeKey: string): string {
  const safe = runtimeKey.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
  return `${safe || 'session'}.json`
}

export function contextSnapshotPath(runtimeKey: string, root: string = YAN_DIR): string {
  return join(root, CONTEXT_SNAPSHOT_DIRNAME, contextSnapshotFileName(runtimeKey))
}

export class ContextAssembler {
  private readonly root: string
  private readonly library: LibraryService

  constructor(options: { root?: string; library?: LibraryService } = {}) {
    this.root = options.root ?? YAN_DIR
    this.library = options.library ?? new LibraryService({ root: this.root })
  }

  /** 装配一轮上下文（只读）。 */
  async assemble(request: AssembleContextRequest): Promise<ContextAssembly> {
    const sources: {
      ref: { sourceId: string; version: number }
      title: string
      text: string
      start: number
    }[] = []

    const sessionId = request.sessionId?.trim()
    if (sessionId) {
      await this.library.store.load()
      const doc = this.library.store.document()
      const refs = refsForOwner(doc, { kind: 'session', id: sessionId })
      const maxSources = request.maxSources ?? DEFAULT_MAX_SOURCES
      const maxChars = request.maxSourceChars ?? DEFAULT_MAX_SOURCE_CHARS
      let taken = 0
      for (const ref of refs) {
        if (taken >= maxSources) break
        /* 只带有正文的引用：附件 / 没有文本层的资料由界面按引用打开，不进上下文 */
        if (!refReadable(doc, ref)) continue
        const opened = await this.library.openRef(ref, { maxChars })
        if (!opened.text?.trim()) continue
        sources.push({
          ref,
          title: opened.source?.title ?? opened.version?.title ?? ref.sourceId,
          text: opened.text,
          start: 0
        })
        taken++
      }
    }

    return assembleContext(
      {
        activity: request.activity,
        ...(request.requirement ? { requirement: request.requirement } : {}),
        ...(request.task ? { task: request.task } : {}),
        ...(request.space ? { space: request.space } : {}),
        ...(request.preference ? { preference: request.preference } : {}),
        ...(sources.length ? { sources } : {})
      },
      request.budget
    )
  }

  /**
   * 装配并写扩展读的快照。
   *
   * 返回装配结果（调用方可能想推给界面）；**写盘失败只吞掉，不抛**。
   */
  async assembleAndWrite(runtimeKey: string, request: AssembleContextRequest): Promise<ContextAssembly> {
    const assembly = await this.assemble(request)
    try {
      await writeContextSnapshot(runtimeKey, assembly, this.root)
    } catch {
      /* 上下文是增强：写不进去不该拦着一轮对话 */
    }
    return assembly
  }
}

export interface ContextSnapshotRecord {
  version: 1
  runtimeKey: string
  activity: AgentActivity
  /** 渲染好的注入文本（`null` = 没有可注入内容）。 */
  section: string | null
  citations: ContextAssembly['citations']
  budget: ContextAssembly['budget']
  at: string
}

export async function writeContextSnapshot(
  runtimeKey: string,
  assembly: ContextAssembly,
  root: string = YAN_DIR
): Promise<ContextSnapshotRecord> {
  const target = contextSnapshotPath(runtimeKey, root)
  await mkdir(dirname(target), { recursive: true })
  const record: ContextSnapshotRecord = {
    version: 1,
    runtimeKey,
    activity: assembly.activity,
    section: renderContextSection(assembly),
    citations: assembly.citations,
    budget: assembly.budget,
    at: new Date().toISOString()
  }
  const temp = `${target}.${process.pid}.tmp`
  await writeFile(temp, JSON.stringify(record), 'utf8')
  try {
    await rename(temp, target)
  } catch {
    await writeFile(target, JSON.stringify(record), 'utf8')
    await rm(temp, { force: true }).catch(() => undefined)
  }
  return record
}

/** 读回快照（只给诊断 / 测试用；模型侧由扩展直接读文件）。 */
export async function readContextSnapshot(
  runtimeKey: string,
  root: string = YAN_DIR
): Promise<ContextSnapshotRecord | null> {
  try {
    const raw = JSON.parse(await readFile(contextSnapshotPath(runtimeKey, root), 'utf8'))
    if (!raw || typeof raw !== 'object') return null
    return raw as ContextSnapshotRecord
  } catch {
    return null
  }
}
