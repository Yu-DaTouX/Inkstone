/**
 * 活动档案的存储与快照（实施-25 P01 / W2）。
 *
 * 与 `work-mode-service` 同一套做法：
 *   · 文档 `YAN_DIR/agent-profiles.json`，带 schema 版本，写盘原子；
 *   · 会话键与工作模式**同一口径**（`normalizeSessionFileKey`）——
 *     同一份会话在图里、模式上、档案上必须是同一个键，否则「切会话不串」失守；
 *   · 每次发消息前把当前实例的档案写一份到
 *     `YAN_DIR/agent-profile/<runtimeKey>.json`，薄层扩展只读文件；
 *   · **关闭 / 缺失时也写文件**（= 默认档案），否则扩展会继续读到上一轮的档案。
 *
 * 为什么不让扩展直接读 `agent-profiles.json`：那是宿主文档（带 revision、
 * 可能很大），扩展只该看到「这个实例此刻是什么」。这与 work-mode 的交接方式一致。
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  DEFAULT_AGENT_ACTIVITY,
  DEFAULT_AGENT_PROFILE,
  activityDeniedTools,
  agentRoleSection,
  isAgentActivity,
  isAgentProfileKind,
  validateAgentProfile,
  type AgentProfile,
  type AgentProfileKind,
  type AgentProfilePatch,
  type AgentProfileState
} from '../shared/agent-profile'
import { YAN_DIR } from './paths'
import { normalizeSessionFileKey, sanitizeWorkModeKey } from './work-mode-service'

export const AGENT_PROFILE_FILE_NAME = 'agent-profiles.json'
/** 扩展读的那份快照目录。 */
export const AGENT_PROFILE_SNAPSHOT_DIRNAME = 'agent-profile'
/** 条目上限：只保留最近更新的这么多条。 */
export const AGENT_PROFILE_MAX_ENTRIES = 2000

export type { AgentProfileState, AgentProfilePatch } from '../shared/agent-profile'

interface StoredAgentProfile extends AgentProfile {
  revision: number
  updatedAt: number
}

interface AgentProfileDocument {
  version: 1
  entries: Record<string, StoredAgentProfile>
}

export function agentProfileDocumentPath(root: string = YAN_DIR): string {
  return join(root, AGENT_PROFILE_FILE_NAME)
}

/** 新会话在 pi 给出稳定 id 之前使用的键（与 work-mode 同一约定）。 */
export function pendingAgentProfileKey(runnerId: string): string {
  return `pending:${runnerId}`
}

export function agentProfileSnapshotFileName(runtimeKey: string): string {
  const safe = runtimeKey.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
  return `${safe || 'session'}.json`
}

export function agentProfileSnapshotPath(runtimeKey: string, root: string = YAN_DIR): string {
  return join(root, AGENT_PROFILE_SNAPSHOT_DIRNAME, agentProfileSnapshotFileName(runtimeKey))
}

/** 会话文件路径 → 稳定键（与 work-mode 共用一个实现，口径必须一致）。 */
export function normalizeProfileSessionKey(file: unknown): string | null {
  const key = normalizeSessionFileKey(file)
  if (!key) return null
  return sanitizeWorkModeKey(key)
}

function sanitizeEntry(raw: unknown): StoredAgentProfile | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (!isAgentProfileKind(o.profile) || !isAgentActivity(o.activity)) return null
  const revision =
    Number.isFinite(o.revision) && Number(o.revision) > 0 ? Math.floor(Number(o.revision)) : 1
  const updatedAt = Number.isFinite(o.updatedAt) ? Number(o.updatedAt) : 0
  const entry: StoredAgentProfile = {
    profile: o.profile,
    activity: o.activity,
    revision,
    updatedAt
  }
  for (const key of ['spaceId', 'taskId', 'courseId'] as const) {
    const value = o[key]
    if (typeof value === 'string' && value.trim()) entry[key] = value.trim()
  }
  return entry
}

/** 读盘的容错口径：坏条目丢掉，不让一份坏档案拦住启动。 */
export function sanitizeAgentProfileDocument(raw: unknown): AgentProfileDocument {
  const source = raw && typeof raw === 'object' ? (raw as Partial<AgentProfileDocument>) : {}
  const rawEntries = source.entries && typeof source.entries === 'object' ? source.entries : {}
  const entries: Record<string, StoredAgentProfile> = {}
  for (const [key, value] of Object.entries(rawEntries as Record<string, unknown>)) {
    const safe = sanitizeWorkModeKey(key)
    const entry = sanitizeEntry(value)
    if (!safe || !entry) continue
    entries[safe] = entry
  }
  const keys = Object.keys(entries)
  if (keys.length > AGENT_PROFILE_MAX_ENTRIES) {
    const keep = keys
      .sort((a, b) => entries[b].updatedAt - entries[a].updatedAt)
      .slice(0, AGENT_PROFILE_MAX_ENTRIES)
    const trimmed: Record<string, StoredAgentProfile> = {}
    for (const key of keep) trimmed[key] = entries[key]
    return { version: 1, entries: trimmed }
  }
  return { version: 1, entries }
}

/** 没有条目时返回默认档案（`revision 0` = 尚未落盘）。 */
export function readAgentProfileState(
  doc: AgentProfileDocument,
  runtimeKey: string,
  fallback: AgentProfileKind = DEFAULT_AGENT_PROFILE
): AgentProfileState {
  const entry = doc.entries[runtimeKey]
  if (!entry) {
    return { profile: isAgentProfileKind(fallback) ? fallback : DEFAULT_AGENT_PROFILE, activity: DEFAULT_AGENT_ACTIVITY, revision: 0 }
  }
  const state: AgentProfileState = { profile: entry.profile, activity: entry.activity, revision: entry.revision }
  if (entry.spaceId) state.spaceId = entry.spaceId
  if (entry.taskId) state.taskId = entry.taskId
  if (entry.courseId) state.courseId = entry.courseId
  return state
}

/**
 * 原子写扩展读的快照。
 *
 * 与 work-mode 同一个 Windows 教训：覆盖已存在文件的 `rename` 会偶发 `EPERM`，
 * 失败退化为直写。
 */
export async function writeAgentProfileSnapshot(
  runtimeKey: string,
  state: AgentProfileState,
  root: string = YAN_DIR
): Promise<void> {
  const target = agentProfileSnapshotPath(runtimeKey, root)
  await mkdir(dirname(target), { recursive: true })
  const record = {
    version: 1,
    runtimeKey,
    profile: state.profile,
    activity: state.activity,
    ...(state.spaceId ? { spaceId: state.spaceId } : {}),
    ...(state.taskId ? { taskId: state.taskId } : {}),
    ...(state.courseId ? { courseId: state.courseId } : {}),
    revision: state.revision,
    /*
     * 角色文本与工具策略由**宿主**在这里渲染好。
     *
     * 为什么不写在薄层扩展里：文案是真源（`shared/agent-profile.ts`），
     * 扩展再抄一份就会漂移（实施-01 的「薄层只做宿主表达不了的那一步」）。
     * 扩展只负责把它放进 `systemPromptOptions`。
     */
    roleSection: agentRoleSection(state.profile, state.activity),
    /*
     * 工具限制只对 `daily` 生效：那些 deny 表描述的是「某个日常活动该不该写文件」，
     * 不是「这个会话能不能写文件」。
     *
     * `auto` 与 `coding` 都不限 —— 活动是模型当场判断的（或根本没选），
     * 拿上一次的 activity 去禁 write/edit 会让一个代码会话突然写不了文件。
     */
    deniedTools: state.profile === 'daily' ? [...activityDeniedTools(state.activity)] : [],
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
}

export interface AgentProfileSetResult {
  ok: boolean
  state: AgentProfileState
  error?: 'version-mismatch' | 'bad-key' | 'invalid-profile'
  detail?: string
}

/**
 * 按会话保存的档案存储（提交形状定义在 shared，渲染端用同一个）。
 */
const EMPTY_STATE: AgentProfileState = {
  profile: DEFAULT_AGENT_PROFILE,
  activity: DEFAULT_AGENT_ACTIVITY,
  revision: 0
}

/**
 * 按会话保存的档案存储。
 *
 * 写操作串成一条队列（与 work-mode / goal 同一个做法）：读-改-写之间不能让
 * 第二个提交插进来，否则 CAS 会因为「都读到旧值」而失效。
 */
export class AgentProfileStore {
  private readonly root: string
  private readonly now: () => number
  private doc: AgentProfileDocument = { version: 1, entries: {} }
  private loaded = false
  private tail: Promise<unknown> = Promise.resolve()

  constructor(options: { root?: string; now?: () => number } = {}) {
    this.root = options.root ?? YAN_DIR
    this.now = options.now ?? Date.now
  }

  async load(): Promise<void> {
    if (this.loaded) return
    try {
      const raw = JSON.parse(await readFile(agentProfileDocumentPath(this.root), 'utf8'))
      this.doc = sanitizeAgentProfileDocument(raw)
    } catch {
      this.doc = { version: 1, entries: {} }
    }
    this.loaded = true
  }

  /** 只读当前状态（不改磁盘）。 */
  state(runtimeKey: string, fallback: AgentProfileKind = DEFAULT_AGENT_PROFILE): AgentProfileState {
    if (!this.loaded) return { ...EMPTY_STATE, profile: fallback }
    return readAgentProfileState(this.doc, runtimeKey, fallback)
  }

  /**
   * 提交一次档案变更。
   *
   * `expectedRevision` 给了就必须匹配（CAS）：两个窗口同时改同一个会话时，
   * 后到的那个会拿到 `version-mismatch`，而不是静默覆盖。
   */
  async set(runtimeKey: string, patch: AgentProfilePatch, expectedRevision?: number): Promise<AgentProfileSetResult> {
    return this.enqueue(async () => {
      const safe = sanitizeWorkModeKey(runtimeKey)
      if (!safe) return { ok: false, state: EMPTY_STATE, error: 'bad-key' as const }
      await this.load()
      const current = readAgentProfileState(this.doc, safe)
      if (expectedRevision !== undefined && expectedRevision !== current.revision) {
        return { ok: false, state: current, error: 'version-mismatch' as const }
      }

      const next: AgentProfile = {
        profile: patch.profile ?? current.profile,
        activity: patch.activity ?? current.activity
      }
      const carry = (key: 'spaceId' | 'taskId' | 'courseId'): void => {
        const incoming = patch[key]
        if (incoming === undefined) {
          if (current[key]) next[key] = current[key]
          return
        }
        if (incoming === null) return // 显式清空
        next[key] = incoming
      }
      carry('spaceId')
      carry('taskId')
      carry('courseId')

      /* 落盘前必须过一遍校验：拼错的枚举不能进文档（T01-4） */
      const check = validateAgentProfile(next)
      if (!check.ok) {
        return { ok: false, state: current, error: 'invalid-profile' as const, detail: check.reason }
      }

      const entry: StoredAgentProfile = { ...check.profile, revision: current.revision + 1, updatedAt: this.now() }
      this.doc = {
        version: 1,
        entries: { ...this.doc.entries, [safe]: entry }
      }
      await this.flush()
      return { ok: true, state: readAgentProfileState(this.doc, safe) }
    })
  }

  /** 新会话拿到稳定键后迁移（迁移不算用户提交，revision 不变）。 */
  async adopt(fromKey: string, toKey: string): Promise<AgentProfileState> {
    return this.enqueue(async () => {
      const from = sanitizeWorkModeKey(fromKey)
      const to = sanitizeWorkModeKey(toKey)
      await this.load()
      if (!from || !to || from === to) return readAgentProfileState(this.doc, to ?? from ?? '')
      const entry = this.doc.entries[from]
      if (!entry) return readAgentProfileState(this.doc, to)
      const entries = { ...this.doc.entries, [to]: entry }
      delete entries[from]
      this.doc = { version: 1, entries }
      await this.flush()
      return readAgentProfileState(this.doc, to)
    })
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.tail.then(job, job)
    this.tail = run.catch(() => undefined)
    return run
  }

  /**
   * 落盘（原子替换）。
   *
   * 失败时把内存恢复到磁盘上的真实内容：业务方法都是「先改 this.doc、再调
   * flush」，不回滚的话报过失败的操作会留在内存里，被下一次成功的写入一起提交。
   */
  private async flush(): Promise<void> {
    const target = agentProfileDocumentPath(this.root)
    const temp = `${target}.${process.pid}.tmp`
    try {
      await mkdir(dirname(target), { recursive: true })
      const payload = JSON.stringify(this.doc)
      await writeFile(temp, payload, 'utf8')
      try {
        await rename(temp, target)
      } catch {
        await writeFile(target, payload, 'utf8')
        await rm(temp, { force: true }).catch(() => undefined)
      }
    } catch (error) {
      try {
        this.doc = sanitizeAgentProfileDocument(JSON.parse(await readFile(agentProfileDocumentPath(this.root), 'utf8')))
      } catch {
        this.doc = { version: 1, entries: {} }
      }
      throw error
    }
  }
}
