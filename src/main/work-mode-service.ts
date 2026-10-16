/**
 * 会话级工作模式的**存储与提交**（实施-05 S2 / §2）。
 *
 * 为什么不是全局设置：模式必须按会话保存 —— A 会话切到自主不得改变 B 会话
 * 的提问行为（§11 的验收项之一）。旧的 `desktop.json.autonomous` 只是
 * **迁移输入**（见 `shared/work-mode.ts`）。
 *
 * ── 身份：先用 runner，再落到稳定会话 ──
 * 新会话在 pi 给出稳定 sessionId 之前，模式按 `pending:<runnerId>` 持有；
 * 拿到稳定 id 后 `adopt()` 把它迁过去（迁移不算一次用户提交，revision 不变）。
 * 这与 `session-layout` 对 pending 归属的处理是同一个思路。
 *
 * ── 给模型侧的那份 ──
 * 薄层扩展（`resources/pi-extensions/question.js`）只能从环境变量知道自己的
 * 运行实例（`YAN_SESSION_ID` = runner id），所以宿主在每次发消息前把该实例的
 * 当前模式写一份到 `YAN_DIR/work-mode/<runnerId>.json`。与项目知识注入同一个
 * 交接方式：宿主办业务，薄层只读文件 + 放进请求。
 *
 * ⚠️ 关闭 / 缺失时也要**写文件**（`standard`），否则扩展会继续读到上一轮的
 * 模式 —— 「切回标准立即生效」正是靠这一步。这与 `project-knowledge` 的
 * 「关闭也写空块」是同一条教训。
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  DEFAULT_SESSION_QUESTION_FREQUENCY,
  normalizeSessionQuestionFrequency,
  type SessionQuestionFrequency
} from '../shared/question-frequency'
import {
  DEFAULT_WORK_MODE,
  isWorkMode,
  normalizeWorkMode,
  type WorkMode,
  type WorkModeState
} from '../shared/work-mode'
import { YAN_DIR } from './paths'

export const WORK_MODE_FILE_NAME = 'work-modes.json'
/** 每会话快照目录（扩展读的那份）。 */
export const WORK_MODE_SNAPSHOT_DIRNAME = 'work-mode'
/** 条目上限：只保留最近更新的这么多条（会话会越用越多）。 */
export const WORK_MODE_MAX_ENTRIES = 2000

interface StoredWorkMode {
  mode: WorkMode
  revision: number
  updatedAt: number
  /**
   * 会话级提问频率偏好。
   *
   * 旧记录没有这个字段：读盘时归一到 `inherit`，写回时总是带上 ——
   * 于是「切回继承」不会残留上次的显式档。
   */
  questionFrequency: SessionQuestionFrequency
  /**
   * 归属校验（`pending:<runnerId>` 记录必须带）：写入时的稳定会话 id。
   *
   * `pending` 键不含会话身份，实例被复用 / 重启后旧 pending 可能属于另一条
   * 会话。迁移前比对 owner：只有能证明「这条 pending 就是当前会话」才搬走；
   * 缺失 / 不匹配一律不迁移（安全回落 `inherit`），不把 A 的偏好冒认给 B。
   */
  owner?: string
}

interface WorkModeDocument {
  version: 1
  entries: Record<string, StoredWorkMode>
}

export function workModeDocumentPath(root: string = YAN_DIR): string {
  return join(root, WORK_MODE_FILE_NAME)
}

/**
 * 存储键的清洗。
 *
 * ⚠️ **允许路径分隔符**：稳定键就是会话文件路径（见 `normalizeSessionFileKey`）——
 * 不能用 pi 的 `state.sessionId`，实测它同一份会话文件会变（切走再切回时
 * pi 内部对象拿到新 id），拿它当键会让用户刚设的模式当场丢失。
 * 所以这里只拦控制字符与超长串；它只作为 JSON 的键，不参与文件名。
 */
export function sanitizeWorkModeKey(key: unknown): string | null {
  if (typeof key !== 'string') return null
  const trimmed = key.trim()
  if (!trimmed || trimmed.length > 400) return null
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null
  return trimmed
}

/**
 * 会话文件路径 → 稳定键。
 *
 * 只归一化分隔符与尾斜杠（不做大小写折叠：Linux 上大小写是两回事）。
 */
export function normalizeSessionFileKey(file: unknown): string | null {
  if (typeof file !== 'string') return null
  const key = file.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  if (!key) return null
  return sanitizeWorkModeKey(key)
}

/**
 * 归属标记的清洗：只接受真实稳定会话 id。
 *
 * `pending:<runnerId>` 这类占位 id 跨重启会重名，不能证明归属，一律当未知
 *（返回 undefined → 迁移时安全回落 `inherit`）。
 */
export function cleanWorkModeOwner(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.startsWith('pending:')) return undefined
  return trimmed.slice(0, 200)
}

/** 新会话在 pi 给出稳定 id 之前使用的键。 */
export function pendingWorkModeKey(runnerId: string): string {
  return `pending:${runnerId}`
}

/**
 * 运行实例 + 稳定会话身份。
 *
 * 用于快照写入 / 会话迁移的精确校验：runner id 只说明「哪个进程」，
 * 同一进程会被复用到别的会话，所以还要 sessionId / sessionFile。
 */
export interface WorkModeIdentity {
  id: string
  /** 注册表代次：同一 runner 被复用到别的会话时会递增。 */
  generation?: number
  sessionId?: string
  sessionFile?: string
}

/** 两条身份是不是同一条会话（含「同一 runner 换了会话」也算变了）。 */
export function sameWorkModeIdentity(a: WorkModeIdentity | null, b: WorkModeIdentity | null): boolean {
  if (!a || !b) return false
  if (a.id !== b.id) return false
  if ((a.generation ?? 0) !== (b.generation ?? 0)) return false
  if ((a.sessionId ?? '') !== (b.sessionId ?? '')) return false
  return normalizeSessionFileKey(a.sessionFile) === normalizeSessionFileKey(b.sessionFile)
}

/** 扩展读的那份文件名（runner id 可能带 `:`，换掉）。 */
export function workModeSnapshotFileName(runtimeKey: string): string {
  const safe = runtimeKey.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
  return `${safe || 'session'}.json`
}

export function workModeSnapshotPath(runtimeKey: string, root: string = YAN_DIR): string {
  return join(root, WORK_MODE_SNAPSHOT_DIRNAME, workModeSnapshotFileName(runtimeKey))
}

/**
 * 快照写入按 runner 串行。
 *
 * 同一个 runner 的快照文件只有一份：两个会话先后复用同一实例时，写入必须排队，
 * 否则 A 的迟到 `rename` 会在 B 写出有效快照之后把 B 覆盖掉。锁只覆盖写入
 * 临界段（含 guard 校验），不扩成任务锁。
 */
const snapshotWriteTails = new Map<string, Promise<unknown>>()

function withSnapshotWriteLock<T>(runtimeKey: string, job: () => Promise<T>): Promise<T> {
  const previous = snapshotWriteTails.get(runtimeKey) ?? Promise.resolve()
  const run = previous.then(job, job)
  const tail = run.then(
    () => undefined,
    () => undefined
  )
  snapshotWriteTails.set(runtimeKey, tail)
  void tail.then(() => {
    if (snapshotWriteTails.get(runtimeKey) === tail) snapshotWriteTails.delete(runtimeKey)
  })
  return run
}

/** 进程内唯一临时名：同一目标并发写（不同 runner 键清洗后同名）也不会互删。 */
let snapshotTempSeq = 0
function snapshotTempPath(target: string): string {
  snapshotTempSeq = (snapshotTempSeq + 1) % Number.MAX_SAFE_INTEGER
  const nonce = Math.random().toString(36).slice(2, 8)
  return `${target}.${process.pid}.${snapshotTempSeq}.${nonce}.tmp`
}

function sanitizeEntry(raw: unknown): StoredWorkMode | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Partial<StoredWorkMode>
  if (!isWorkMode(o.mode)) return null
  const revision = Number.isFinite(o.revision) && Number(o.revision) > 0 ? Math.floor(Number(o.revision)) : 1
  const updatedAt = Number.isFinite(o.updatedAt) ? Number(o.updatedAt) : 0
  const owner = cleanWorkModeOwner(o.owner)
  return {
    mode: o.mode,
    revision,
    updatedAt,
    /* 缺字段 / 脏值 → 继承全局（旧文件兼容，也不把旧显式档带过来） */
    questionFrequency: normalizeSessionQuestionFrequency(o.questionFrequency),
    ...(owner ? { owner } : {})
  }
}

export function sanitizeWorkModeDocument(raw: unknown): WorkModeDocument {
  const source = raw && typeof raw === 'object' ? (raw as Partial<WorkModeDocument>) : {}
  const rawEntries = source.entries && typeof source.entries === 'object' ? source.entries : {}
  const entries: Record<string, StoredWorkMode> = {}
  for (const [key, value] of Object.entries(rawEntries as Record<string, unknown>)) {
    const safe = sanitizeWorkModeKey(key)
    const entry = sanitizeEntry(value)
    if (!safe || !entry) continue
    entries[safe] = entry
  }
  const keys = Object.keys(entries)
  if (keys.length > WORK_MODE_MAX_ENTRIES) {
    const keep = keys
      .sort((a, b) => entries[b].updatedAt - entries[a].updatedAt)
      .slice(0, WORK_MODE_MAX_ENTRIES)
    const trimmed: Record<string, StoredWorkMode> = {}
    for (const key of keep) trimmed[key] = entries[key]
    return { version: 1, entries: trimmed }
  }
  return { version: 1, entries }
}

/** 读一份内存里的状态；没有条目时返回默认值（revision 0 = 尚未落盘）。 */
export function readWorkModeState(
  doc: WorkModeDocument,
  runtimeKey: string,
  fallback: WorkMode = DEFAULT_WORK_MODE
): WorkModeState {
  const entry = doc.entries[runtimeKey]
  if (!entry) {
    return {
      mode: normalizeWorkMode(fallback),
      revision: 0,
      questionFrequency: DEFAULT_SESSION_QUESTION_FREQUENCY
    }
  }
  return {
    mode: entry.mode,
    revision: entry.revision,
    questionFrequency: entry.questionFrequency
  }
}

/** 快照归属：写文件时记录这条快照属于哪个稳定会话，扩展读时核对。 */
export interface WorkModeSnapshotOwner {
  sessionId?: string
  sessionFile?: string
}

/**
 * 把一份模式状态原子写到扩展读的快照文件。
 *
 * 原子写 + rename 失败退化为直写：Windows 上覆盖已存在文件的 `rename`
 * 会偶发 `EPERM`，失败时保留直接写入的兼容路径。
 *
 * `options.guard` 在拿到写入锁之后、以及 `rename` 之前各校验一次：实例被复用
 * 到别的会话时，旧会话的迟到写入在关键段直接放弃，不会覆盖新会话的有效快照。
 * 临时文件带进程内唯一后缀，失败只清理自己那一个。返回是否真的落盘。
 */
export async function writeWorkModeSnapshot(
  runtimeKey: string,
  state: WorkModeState & { planApprovalPending?: boolean },
  root: string = YAN_DIR,
  options: { guard?: () => boolean; owner?: WorkModeSnapshotOwner } = {}
): Promise<boolean> {
  const { guard, owner } = options
  return withSnapshotWriteLock(runtimeKey, async () => {
    if (guard && !guard()) return false
    const target = workModeSnapshotPath(runtimeKey, root)
    await mkdir(dirname(target), { recursive: true })
    const record = {
      version: 1,
      runtimeKey,
      mode: state.mode,
      revision: state.revision,
      /* 每次快照都带频率：显式档写入，inherit 也写入 —— 擦掉上一轮的显式残留 */
      questionFrequency: normalizeSessionQuestionFrequency(state.questionFrequency),
      ...(owner?.sessionId ? { sessionId: owner.sessionId } : {}),
      ...(owner?.sessionFile ? { sessionFile: owner.sessionFile } : {}),
      planApprovalPending: state.planApprovalPending === true,
      at: new Date().toISOString()
    }
    const body = JSON.stringify(record)
    const temp = snapshotTempPath(target)
    try {
      await writeFile(temp, body, 'utf8')
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {})
      throw error
    }
    if (guard && !guard()) {
      await rm(temp, { force: true }).catch(() => {})
      return false
    }
    try {
      await rename(temp, target)
    } catch {
      try {
        await writeFile(target, body, 'utf8')
      } finally {
        await rm(temp, { force: true }).catch(() => {})
      }
    }
    return true
  })
}

/**
 * 读一份已写出的快照（频域提交要保留的待审标记；`mode` 仅供诊断 / 测试）。
 *
 * 为什么需要它：会话频率提交会重写快照，`writeWorkModeSnapshot` 总是写
 * `planApprovalPending`。重写前读出旧值，才能不把「待批准计划」这个必要
 * 标记冲掉。模式本身不从这里取 —— 轻量客户端的投影固定 `standard`，不因
 * 频率改动复活旧快照里的 `clarify` / `autonomous`。
 */
export async function readWorkModeSnapshot(
  runtimeKey: string,
  root: string = YAN_DIR
): Promise<{
  mode?: WorkMode
  questionFrequency?: SessionQuestionFrequency
  planApprovalPending?: boolean
  sessionId?: string
  sessionFile?: string
} | null> {
  try {
    const raw = JSON.parse(await readFile(workModeSnapshotPath(runtimeKey, root), 'utf8'))
    if (!raw || typeof raw !== 'object') return null
    const o = raw as Record<string, unknown>
    return {
      mode: isWorkMode(o.mode) ? o.mode : undefined,
      questionFrequency: normalizeSessionQuestionFrequency(o.questionFrequency),
      planApprovalPending: o.planApprovalPending === true,
      sessionId: typeof o.sessionId === 'string' && o.sessionId.trim() ? o.sessionId : undefined,
      sessionFile: typeof o.sessionFile === 'string' && o.sessionFile.trim() ? o.sessionFile : undefined
    }
  } catch {
    return null
  }
}

export interface WorkModeSetResult {
  ok: boolean
  state: WorkModeState
  error?: 'version-mismatch' | 'bad-key'
}

/** 会话提问频率的提交结果；revision 与模式共用（旧记录兼容）。 */
export type QuestionFrequencySetResult = WorkModeSetResult

/**
 * 会话模式的存储。
 *
 * 单进程内的写操作排成一条队列（与 `session-layout` 同一个做法）：
 * 读-改-写之间不能让第二个提交插进来，否则 CAS 会因为「都读到旧值」而失效。
 */
export class WorkModeStore {
  private readonly root: string
  private readonly now: () => number
  private doc: WorkModeDocument = { version: 1, entries: {} }
  private loaded = false
  private tail: Promise<unknown> = Promise.resolve()

  constructor(options: { root?: string; now?: () => number } = {}) {
    this.root = options.root ?? YAN_DIR
    this.now = options.now ?? Date.now
  }

  /** 读盘（幂等）。读不到 / 坏了都当空文档 —— 模式不是关键数据，不能拦住启动。 */
  async load(): Promise<void> {
    if (this.loaded) return
    try {
      const raw = JSON.parse(await readFile(workModeDocumentPath(this.root), 'utf8'))
      this.doc = sanitizeWorkModeDocument(raw)
    } catch {
      this.doc = { version: 1, entries: {} }
    }
    this.loaded = true
  }

  /** 缺省模式**不落盘**：新会话在用户真正切换之前不该在磁盘上留下记录。 */
  state(runtimeKey: string, fallback: WorkMode = DEFAULT_WORK_MODE): WorkModeState {
    const key = sanitizeWorkModeKey(runtimeKey)
    if (!key) {
      return { mode: normalizeWorkMode(fallback), revision: 0, questionFrequency: DEFAULT_SESSION_QUESTION_FREQUENCY }
    }
    return readWorkModeState(this.doc, key, fallback)
  }

  /**
   * 提交模式。
   *
   * `expectedRevision` 是可选的乐观锁：界面带上自己读到的 revision；
   * 不一致时**不写**并返回当前值，让界面恢复显示（§3「提交失败不出现
   * UI 已自主而扩展仍标准」）。
   */
  async set(
    runtimeKey: string,
    mode: WorkMode,
    expectedRevision?: number,
    owner?: string
  ): Promise<WorkModeSetResult> {
    const key = sanitizeWorkModeKey(runtimeKey)
    if (!key) {
      return {
        ok: false,
        state: { mode: normalizeWorkMode(mode), revision: 0, questionFrequency: DEFAULT_SESSION_QUESTION_FREQUENCY },
        error: 'bad-key'
      }
    }
    return this.enqueue(async () => {
      const current = this.state(key)
      if (expectedRevision !== undefined && expectedRevision !== current.revision) {
        return { ok: false, state: current, error: 'version-mismatch' as const }
      }
      const previous = this.doc.entries[key]
      const nextOwner = cleanWorkModeOwner(owner) ?? previous?.owner
      const next: StoredWorkMode = {
        mode: normalizeWorkMode(mode),
        revision: current.revision + 1,
        updatedAt: this.now(),
        /* 改模式**不得**抹掉同一条记录上的频率覆盖（两个入口共用一个 revision） */
        questionFrequency: normalizeSessionQuestionFrequency(current.questionFrequency),
        ...(nextOwner ? { owner: nextOwner } : {})
      }
      this.doc.entries[key] = next
      try {
        await this.persist()
      } catch (error) {
        if (previous) this.doc.entries[key] = previous
        else delete this.doc.entries[key]
        throw error
      }
      return { ok: true, state: { mode: next.mode, revision: next.revision, questionFrequency: next.questionFrequency } }
    })
  }

  /**
   * 提交会话级提问频率偏好。
   *
   * 与 `set` 共用同一条记录与 revision：两个入口各自读当前值再写回，
   * 所以并发提交不会互相抹掉字段（读-改-写在 store 的队列里串行）。
   * `expectedRevision` 是可选的乐观锁，界面提交时带上；不一致就不写并
   * 返回当前值。
   *
   * 新会话直接设为 `inherit`（等于没有覆盖）时**不落盘** —— 与「默认模式
   * 不落盘」同一条约定：用户没真正改过就不该在磁盘上留下记录。
   */
  async setQuestionFrequency(
    runtimeKey: string,
    preference: unknown,
    expectedRevision?: number,
    owner?: string
  ): Promise<QuestionFrequencySetResult> {
    const key = sanitizeWorkModeKey(runtimeKey)
    const freq = normalizeSessionQuestionFrequency(preference)
    if (!key) {
      return {
        ok: false,
        state: { mode: DEFAULT_WORK_MODE, revision: 0, questionFrequency: freq },
        error: 'bad-key'
      }
    }
    return this.enqueue(async () => {
      const current = this.state(key)
      if (expectedRevision !== undefined && expectedRevision !== current.revision) {
        return { ok: false, state: current, error: 'version-mismatch' as const }
      }
      const previous = this.doc.entries[key]
      if (!previous && freq === DEFAULT_SESSION_QUESTION_FREQUENCY) {
        return {
          ok: true,
          state: { mode: current.mode, revision: current.revision, questionFrequency: freq }
        }
      }
      const nextOwner = cleanWorkModeOwner(owner) ?? previous?.owner
      const next: StoredWorkMode = {
        /* 保留同一个入口上的模式：改频率不是改模式 */
        mode: current.mode,
        revision: current.revision + 1,
        updatedAt: this.now(),
        questionFrequency: freq,
        ...(nextOwner ? { owner: nextOwner } : {})
      }
      this.doc.entries[key] = next
      try {
        await this.persist()
      } catch (error) {
        if (previous) this.doc.entries[key] = previous
        else delete this.doc.entries[key]
        throw error
      }
      return {
        ok: true,
        state: { mode: next.mode, revision: next.revision, questionFrequency: next.questionFrequency }
      }
    })
  }

  /**
   * pending 键 → 稳定 sessionId。
   *
   * 迁移**不算一次用户提交**（revision 不变）；目标已有条目时保留目标
   * （那意味着这个稳定会话本来就有一个更权威的值）。整个条目一起搬，
   * 所以频率偏好也跟着 pending → 稳定键走。
   */
  async adopt(fromKey: string, toKey: string, options: { requireOwner?: string } = {}): Promise<WorkModeState> {
    const from = sanitizeWorkModeKey(fromKey)
    const to = sanitizeWorkModeKey(toKey)
    if (!to || !from || from === to) return this.state(to ?? from ?? '')
    return this.enqueue(async () => {
      const source = this.doc.entries[from]
      /* 归属不可证（缺失 / 不匹配）就不迁移：旧 pending 可能属于被复用前的会话 */
      if (options.requireOwner !== undefined && source && source.owner !== options.requireOwner) {
        return this.state(to)
      }
      const existing = this.doc.entries[to]
      if (!existing && source) {
        this.doc.entries[to] = { ...source }
        delete this.doc.entries[from]
        await this.persist()
      } else if (existing && source) {
        delete this.doc.entries[from]
        await this.persist()
      }
      return this.state(to)
    })
  }

  /** 测试与诊断用：当前内存文档的只读副本。 */
  snapshot(): WorkModeDocument {
    return { version: 1, entries: { ...this.doc.entries } }
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.tail.then(job, job)
    this.tail = run.catch(() => {})
    return run
  }

  private async persist(): Promise<void> {
    const file = workModeDocumentPath(this.root)
    await mkdir(this.root, { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(this.doc, null, 2), 'utf8')
    try {
      await rename(temp, file)
    } catch {
      await writeFile(file, JSON.stringify(this.doc, null, 2), 'utf8')
      await rm(temp, { force: true }).catch(() => {})
    }
  }
}

/**
 * pending → 稳定键的安全迁移。
 *
 * 只在 key 已经稳定（拿到 sessionFile）且 owner 可证时搬走整条记录：
 * runner 被复用 / 跨重启时，旧 `pending:<runnerId>` 可能属于另一条会话，
 * 缺失 / 不匹配的归属绝不冒认（目标保持 `inherit`）。revision 随整条记录保留。
 */
export async function adoptPendingWorkMode(
  store: WorkModeStore,
  runnerId: string,
  sessionId: string | undefined,
  targetKey: string
): Promise<void> {
  const pendingKey = pendingWorkModeKey(runnerId)
  if (targetKey === pendingKey) return
  const owner = cleanWorkModeOwner(sessionId)
  if (!owner) return
  await store.load()
  await store.adopt(pendingKey, targetKey, { requireOwner: owner })
}

/**
 * `desktop.json` 里的旧开关（迁移输入，只读不写）。
 *
 * 与 `readProjectKnowledgeEnabled` 同一个理由：这个函数会被不依赖 Electron
 * 的调用方（扩展测试 / 纯 Node）用到，所以直读文件，不 import `main/settings`。
 */
export async function readLegacyAutonomous(root: string = YAN_DIR): Promise<unknown> {
  try {
    const parsed = JSON.parse(await readFile(join(root, 'desktop.json'), 'utf8'))
    return parsed?.autonomous
  } catch {
    return undefined
  }
}
