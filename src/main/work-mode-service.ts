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

/** 新会话在 pi 给出稳定 id 之前使用的键。 */
export function pendingWorkModeKey(runnerId: string): string {
  return `pending:${runnerId}`
}

/** 扩展读的那份文件名（runner id 可能带 `:`，换掉）。 */
export function workModeSnapshotFileName(runtimeKey: string): string {
  const safe = runtimeKey.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
  return `${safe || 'session'}.json`
}

export function workModeSnapshotPath(runtimeKey: string, root: string = YAN_DIR): string {
  return join(root, WORK_MODE_SNAPSHOT_DIRNAME, workModeSnapshotFileName(runtimeKey))
}

function sanitizeEntry(raw: unknown): StoredWorkMode | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Partial<StoredWorkMode>
  if (!isWorkMode(o.mode)) return null
  const revision = Number.isFinite(o.revision) && Number(o.revision) > 0 ? Math.floor(Number(o.revision)) : 1
  const updatedAt = Number.isFinite(o.updatedAt) ? Number(o.updatedAt) : 0
  return { mode: o.mode, revision, updatedAt }
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
  if (!entry) return { mode: normalizeWorkMode(fallback), revision: 0 }
  return { mode: entry.mode, revision: entry.revision }
}

/**
 * 把一份模式状态原子写到扩展读的快照文件。
 *
 * 原子写 + rename 失败退化为直写：Windows 上覆盖已存在文件的 `rename`
 * 会偶发 `EPERM`（项目知识注入踩过，见 `project-knowledge.ts`）。
 */
export async function writeWorkModeSnapshot(
  runtimeKey: string,
  state: WorkModeState & { planApprovalPending?: boolean },
  root: string = YAN_DIR
): Promise<void> {
  const target = workModeSnapshotPath(runtimeKey, root)
  await mkdir(dirname(target), { recursive: true })
  const record = {
    version: 1,
    runtimeKey,
    mode: state.mode,
    revision: state.revision,
    planApprovalPending: state.planApprovalPending === true,
    at: new Date().toISOString()
  }
  const temp = `${target}.${process.pid}.tmp`
  await writeFile(temp, JSON.stringify(record), 'utf8')
  try {
    await rename(temp, target)
  } catch {
    await writeFile(target, JSON.stringify(record), 'utf8')
    await rm(temp, { force: true }).catch(() => {})
  }
}

export interface WorkModeSetResult {
  ok: boolean
  state: WorkModeState
  error?: 'version-mismatch' | 'bad-key'
}

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
    if (!key) return { mode: normalizeWorkMode(fallback), revision: 0 }
    return readWorkModeState(this.doc, key, fallback)
  }

  /**
   * 提交模式。
   *
   * `expectedRevision` 是可选的乐观锁：界面带上自己读到的 revision；
   * 不一致时**不写**并返回当前值，让界面恢复显示（§3「提交失败不出现
   * UI 已自主而扩展仍标准」）。
   */
  async set(runtimeKey: string, mode: WorkMode, expectedRevision?: number): Promise<WorkModeSetResult> {
    const key = sanitizeWorkModeKey(runtimeKey)
    if (!key) return { ok: false, state: { mode: normalizeWorkMode(mode), revision: 0 }, error: 'bad-key' }
    return this.enqueue(async () => {
      const current = this.state(key)
      if (expectedRevision !== undefined && expectedRevision !== current.revision) {
        return { ok: false, state: current, error: 'version-mismatch' as const }
      }
      const next: StoredWorkMode = {
        mode: normalizeWorkMode(mode),
        revision: current.revision + 1,
        updatedAt: this.now()
      }
      this.doc.entries[key] = next
      await this.persist()
      return { ok: true, state: { mode: next.mode, revision: next.revision } }
    })
  }

  /**
   * pending 键 → 稳定 sessionId。
   *
   * 迁移**不算一次用户提交**（revision 不变）；目标已有条目时保留目标
   * （那意味着这个稳定会话本来就有一个更权威的值）。
   */
  async adopt(fromKey: string, toKey: string): Promise<WorkModeState> {
    const from = sanitizeWorkModeKey(fromKey)
    const to = sanitizeWorkModeKey(toKey)
    if (!to || !from || from === to) return this.state(to ?? from ?? '')
    return this.enqueue(async () => {
      const existing = this.doc.entries[to]
      if (!existing && this.doc.entries[from]) {
        this.doc.entries[to] = { ...this.doc.entries[from] }
        delete this.doc.entries[from]
        await this.persist()
      } else if (existing && this.doc.entries[from]) {
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
