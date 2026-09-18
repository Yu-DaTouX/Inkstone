/**
 * 项目知识的**注入准备**（实施-03 S3）。
 *
 * 分工刻意拆成两半：
 *   · **检索与渲染在宿主**（这个文件 + `shared/project-memory-search.ts`）——
 *     算法、预算、状态过滤都是业务逻辑，不能放进薄层扩展；
 *   · **最后一步的注入在薄层**（`resources/pi-extensions/project-knowledge.js`）——
 *     「请求发出前把一段材料放进上下文」只有 pi 的钩子能表达，没有任何 CLI / RPC 等价物。
 *
 * 两者之间用**一个每会话一档的文件**交接（`_inject/<sessionId>.json`）：
 * 宿主在用户消息落进 pi 之前写好，扩展在 `before_provider_request` 读它。
 * 为什么不是扩展反过来调宿主接口：那需要 S4 的 CLI 身份通道，而且会让
 * 「这一轮到底注入了什么」变成一个只能从网络层看出来的事实 —— 落文件可回读、可断言。
 *
 * ⚠️ 关闭时也**必须写文件**（`enabled:false` / 空 block）：否则扩展会读到上一轮
 * 那份旧块 —— 「关闭立即失效」正是靠这一步，而不是靠清缓存。
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isSafeProjectId, type ProjectIdentity } from '../shared/project-memory'
import {
  renderKnowledgeBlock,
  searchProjectKnowledge,
  type KnowledgeSearchHit,
  type KnowledgeSearchQuery
} from '../shared/project-memory-search'
import { YAN_DIR } from './paths'
import { listKnowledge } from './project-memory-store'

/** 注入文件的目录名。故意用 `_` 开头：合法的 `projectId` 不可能长成这样（见 isSafeProjectId）。 */
export const KNOWLEDGE_INJECT_DIRNAME = '_inject'

export type KnowledgeInjectionReason =
  | 'ok'
  | 'disabled'
  | 'no-project'
  | 'empty-query'
  | 'no-match'
  | 'over-budget'
  | 'read-failed'

export interface KnowledgeInjectionRecord {
  version: 1
  at: string
  sessionId: string
  enabled: boolean
  projectId?: string
  reason: KnowledgeInjectionReason
  /** 命中条目的 id / 依据 / 分数（诊断与 live 取证用；正文在 block 里）。 */
  hits: { id: string; kind: string; score: number; reasons: string[]; reviewNeeded: boolean }[]
  tokens: number
  block: string
}

/**
 * 会话键 → 文件名。
 *
 * 会话键来自宿主（`run:<id>` 或稳定 sessionId），不是模型输入；仍然做一遍
 * 白名单替换 —— 一个带路径分隔符的键会把注入文件写到别处去。
 */
export function knowledgeInjectFileName(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
  return `${safe || 'session'}.json`
}

export function knowledgeInjectDir(root: string = YAN_DIR): string {
  return join(root, 'project-knowledge', KNOWLEDGE_INJECT_DIRNAME)
}

export function knowledgeInjectPath(sessionId: string, root: string = YAN_DIR): string {
  return join(knowledgeInjectDir(root), knowledgeInjectFileName(sessionId))
}

/** 命中列表的紧凑投影（不重复正文，正文在 block 里）。 */
function summarizeHits(hits: readonly KnowledgeSearchHit[]): KnowledgeInjectionRecord['hits'] {
  return hits.map((hit) => ({
    id: hit.id,
    kind: hit.kind,
    score: Number(hit.score.toFixed(3)),
    reasons: [...hit.reasons],
    reviewNeeded: hit.reviewNeeded
  }))
}

/**
 * 读 `desktop.json` 里的 `projectKnowledge.enabled`（只认字面 `true`）。
 *
 * 为什么不直接用 `main/settings.ts` 的 `getSettings()`：那个模块依赖 Electron
 * 的 `app`（默认语言探测），而 AgentController 同时被纯 Node 单测 import
 * （`test-stream-deltas.mjs` → `out/test/agent.mjs`）—— 一引 electron，
 * 整个单测批次会以「Dynamic require of "child_process"」崩掉。
 *
 * 所以这里读**文件本身**：与扩展读 `desktop.json` 完全同一条口子，
 * 清洗规则也照抄（非法值一律当作关）。代价是路径规则在两处重复 ——
 * 由单测钉住（见 `test-project-knowledge.mjs`）。
 */
export async function readProjectKnowledgeEnabled(root: string = YAN_DIR): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(join(root, 'desktop.json'), 'utf8'))
    return parsed?.projectKnowledge?.enabled === true
  } catch {
    return false
  }
}

export interface PrepareKnowledgeInjectionOptions {
  sessionId: string
  /** 宿主解析出的项目身份；没有（未登记项目 / 新会话尚未落盘）时不检索。 */
  identity?: ProjectIdentity
  /** 这一轮的用户输入（原文）。 */
  queryText: string
  enabled: boolean
  limit?: number
  tokenBudget?: number
  /** 当前分支 / commit / 仍存在的路径，用于「需复核」标记。 */
  current?: KnowledgeSearchQuery['current']
  root?: string
  /** 测试通道：注入 prepare 用不到，但让调用方可以注入时钟（默认 Date.now）。 */
  now?: () => Date
}

/**
 * 准备这一轮的注入记录并**原子落盘**，返回写下去的内容。
 *
 * 失败（manifest 读不了等）不抛给调用方：查知识失败不该拦住用户发消息。
 * 但**必须**留下一份 `read-failed` 记录把上一轮的内容清掉 —— 否则模型会继续
 * 看到过期材料，而磁盘上又看不出发生过什么。
 */
export async function prepareProjectKnowledgeInjection(
  options: PrepareKnowledgeInjectionOptions
): Promise<KnowledgeInjectionRecord> {
  const now = options.now?.() ?? new Date()
  const record: KnowledgeInjectionRecord = {
    version: 1,
    at: now.toISOString(),
    sessionId: options.sessionId,
    enabled: options.enabled,
    projectId: options.identity?.projectId,
    reason: 'ok',
    hits: [],
    tokens: 0,
    block: ''
  }

  if (!options.enabled) {
    record.reason = 'disabled'
  } else if (!options.identity || !isSafeProjectId(options.identity.projectId)) {
    record.reason = 'no-project'
  } else {
    try {
      const entries = await listKnowledge(options.identity, { root: options.root })
      const result = searchProjectKnowledge(entries, {
        queryText: options.queryText,
        limit: options.limit,
        tokenBudget: options.tokenBudget,
        current: options.current
      })
      record.hits = summarizeHits(result.hits)
      record.tokens = result.tokens
      record.reason = result.hits.length > 0 ? 'ok' : (result.reason ?? 'no-match')
      record.block = renderKnowledgeBlock(result)
    } catch {
      record.reason = 'read-failed'
    }
  }

  await writeInjectionRecord(record, options.root)
  return record
}

/**
 * 原子写：先写同目录临时文件再 `rename`。
 *
 * 扩展可能正好在写入过程中读 —— 直接 `writeFile` 会让它读到半个 JSON，
 * 那一刻的表现是「这一轮没注入」，看起来像功能时好时坏。
 *
 * ⚠️ Windows 上「覆盖已存在文件」的 `rename` 会偶发 `EPERM`（目标可能正被读）——
 * 实测踩过：第一轮写成功、第二轮覆盖失败后被 `catch` 吞掉，于是注入文件永远
 * 停在第一轮的 `enabled:true`（开关看起来生效了，磁盘上没生效）。
 * 所以这里退一步：rename 失败就直写目标并清掉临时文件。
 */
export async function writeInjectionRecord(
  record: KnowledgeInjectionRecord,
  root: string = YAN_DIR
): Promise<void> {
  const target = knowledgeInjectPath(record.sessionId, root)
  await mkdir(dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.tmp`
  await writeFile(temp, JSON.stringify(record), 'utf8')
  try {
    await rename(temp, target)
  } catch {
    await writeFile(target, JSON.stringify(record), 'utf8')
    await rm(temp, { force: true }).catch(() => {})
  }
}
