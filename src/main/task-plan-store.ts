/**
 * 宿主任务计划服务：任务清单的**唯一写入方**（实施-02 S3）。
 *
 * 位置：`YAN_DATA_DIR/task-plans/<sessionId>.jsonl`（一行一次提交，**只追加**）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么不是写会话 JSONL
 * ══════════════════════════════════════════════════════════════════
 * pi 的 RPC 没有「追加 custom entry」这个命令（命令表见
 * `resources/pi-runtime/dist/bundle/chunks`：get_entries / fork / … 里都没有），
 * 而协议层又**不许**外部直接编辑正在使用的会话文件：
 *   · pi 的 SessionManager 在内存里维护 parentId 链与 leaf，
 *     外部追加会让文件与内存状态分叉（它下一次 append 时 parentId 指回旧 head）；
 *   · 01 §5 的迁移要求写的是「**新数据由宿主保存**」+「不能直接编辑正在使用的 pi JSONL」。
 * 所以宿主写自己的日志，界面把「宿主日志 + 会话里的旧条目」合并显示
 * （合并规则见 [todoSnapshotsFromEntries]）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 四条必须守住的性质（S3 的出口就是它们）
 * ══════════════════════════════════════════════════════════════════
 * **① 只追加。** 历史行一个字节都不重写：旧版本（哪怕只差一个 revision）
 *   永远读得回来。整份覆盖写会让「上一轮列了什么」在崩溃/并发下消失。
 *
 * **② 同一个会话串行。** 两次快速 `add` 必须排队（各读一次最新状态）。
 *   不串行的话两次都读到 `revision: 0`，第二次的清单会覆盖掉第一次的
 *   —— 那正是「并行操作串数据」的现场。
 *
 * **③ CAS 与幂等靠磁盘，不靠内存缓存。** 每次提交前**从文件读回**当前的
 *   `revision` / `operationId` 再比。进程重启、pi 重启、多个实例都不会让
 *   幂等失效（内存缓存一重启就没了，「重试不重复 add」也就没了）。
 *
 * **④ 落盘失败不得报成功。** 写入用 `write + fsync`，写完**回读校验**最后一行；
 *   任何一步失败都抛错，调用方据此回 `ok:false`。宁可让模型重试，
 *   也不能让它以为写上了（用户会在界面上看到一份没变的清单，却没有任何提示）。
 *
 * 本模块不 import pi、不注册工具、不碰会话文件。
 */
import { mkdir, open, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { YAN_DIR } from './paths'
import { isSafeSessionId } from './context-state-store'
import {
  applyTaskRequest,
  emptyTaskPlan,
  parseTaskPlanLogLine,
  planStateOf,
  readTaskPlanEntry,
  serializeTaskPlanLogRecord,
  toTaskPlanEntryData,
  type TaskChange,
  type TaskErrorCode,
  type TaskPlanLogRecord,
  type TaskPlanRequest,
  type TaskPlanState
} from '../shared/task-plan'

export const TASK_PLAN_DIRNAME = 'task-plans'

/** 派生日志目录（`dir` 覆盖只给测试 / 隔离场景用，生产不传）。 */
export function taskPlanDir(dir?: string): string {
  return dir ?? join(YAN_DIR, TASK_PLAN_DIRNAME)
}

/**
 * 会话日志路径。
 *
 * 会话 id 直接进文件名，所以复用 `context-state-store` 的路径穿越判据
 * （同一套规则，不复制第二份）。顺带挡住 `pending:<runnerId>` ——
 * 会话还没就绪时**不该**写入任务（那份清单不知道该属于谁）。
 */
export function taskPlanLogPath(sessionId: string, dir?: string): string {
  if (!isSafeSessionId(sessionId)) {
    throw new TaskPlanStoreError('bad_session_id', `会话 id 不合法，不能作为任务日志文件名：${sessionId}`)
  }
  return join(taskPlanDir(dir), `${sessionId}.jsonl`)
}

/** 存储层错误（区别于「请求本身不合法」的 [TaskErrorCode]）。 */
export class TaskPlanStoreError extends Error {
  constructor(
    readonly code: 'bad_session_id' | 'read_failed' | 'write_failed',
    message: string
  ) {
    super(message)
    this.name = 'TaskPlanStoreError'
  }
}

export interface TaskPlanStoreOptions {
  /** 日志目录覆盖（测试 / live 场景用隔离目录，不碰用户数据）。 */
  dir?: string
}

/**
 * 读回一份会话的全部日志记录（按写入顺序）。
 *
 * 文件不存在 = 这个会话还没有宿主写入（回空数组，不是错误）。
 * 单行坏数据**跳过**（历史宽容）：一行坏 JSON 不该让整份任务历史消失 ——
 * 但读文件本身失败（权限 / 磁盘错误）要**抛错**，
 * 不能把「读不了」当成「没有清单」：那会让下一次写入基于空清单，等于悄悄清空。
 */
export async function readTaskPlanLog(
  sessionId: string,
  opts: TaskPlanStoreOptions = {}
): Promise<TaskPlanLogRecord[]> {
  const path = taskPlanLogPath(sessionId, opts.dir)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return []
    throw new TaskPlanStoreError('read_failed', `任务日志读不了：${describe(err)}`)
  }
  const out: TaskPlanLogRecord[] = []
  for (const line of text.split('\n')) {
    const record = parseTaskPlanLogLine(line)
    if (record) out.push(record)
  }
  return out
}

/** 会话当前的宿主任务状态（没有写入过 → 空计划）。 */
export async function currentTaskPlan(
  sessionId: string,
  opts: TaskPlanStoreOptions = {}
): Promise<{ state: TaskPlanState; record: TaskPlanLogRecord | null }> {
  const records = await readTaskPlanLog(sessionId, opts)
  const last = records[records.length - 1]
  if (!last) return { state: emptyTaskPlan(), record: null }
  const stored = readTaskPlanEntry(last.data)
  /* `readTaskPlanLog` 已过滤认不出的行，这里再兜一层（防御：别拿 undefined 当空计划） */
  if (!stored) return { state: emptyTaskPlan(), record: null }
  return { state: planStateOf(stored), record: last }
}

export interface ApplyTaskPlanArgs {
  /** 当前 pi 会话 id（**不是** runner 实例 id —— 数据按会话归属）。 */
  sessionId: string
  /** 这次提交属于第几轮用户消息（留给界面历史分组）。 */
  round: number
  request: TaskPlanRequest
  opts?: TaskPlanStoreOptions
}

export type ApplyTaskPlanOutcome =
  | {
      ok: true
      state: TaskPlanState
      changed: TaskChange[]
      /** `true` = 同一个 `operationId` 重放，**没有**再写一行、`revision` 也没涨。 */
      replayed: boolean
      /** 这次提交对应的日志记录；重放时是**原来那一行**（没有新记录）。 */
      record: TaskPlanLogRecord
    }
  | { ok: false; code: TaskErrorCode; message: string }

/**
 * 按会话串行的写入队列。
 *
 * 存的是「永不 reject」的 promise：前一个操作失败**不能**把后面排队的操作
 * 一起带崩（排队的是「轮到我了」，不是「前面成功了」）。
 * 键是 sessionId —— 两个会话并行操作互不阻塞，同一会话严格排队。
 */
const tails = new Map<string, Promise<unknown>>()

export function applyTaskPlanOperation(args: ApplyTaskPlanArgs): Promise<ApplyTaskPlanOutcome> {
  const tail = tails.get(args.sessionId) ?? Promise.resolve()
  const next = tail.then(
    () => applyUnlocked(args),
    () => applyUnlocked(args)
  )
  tails.set(
    args.sessionId,
    next.catch(() => undefined)
  )
  return next
}

async function applyUnlocked(args: ApplyTaskPlanArgs): Promise<ApplyTaskPlanOutcome> {
  const { state: prev, record: prevRecord } = await currentTaskPlan(args.sessionId, args.opts ?? {})

  /* 纯函数层：校验 + 六操作 + 幂等 + `revision` 递增（S2，规则唯一真源） */
  const result = applyTaskRequest(prev, args.request)
  if (!result.ok) return result

  /*
   * 重放：上一次提交就是它。**不写盘**（写进去会多出一行内容完全相同的记录，
   * 界面的「历史任务」会平白多一份，而用户什么都没做过）。
   * `applyTaskRequest` 在重放时返回的是 `prev` 本体，`prevRecord` 就是那一行。
   */
  if (result.replayed) {
    if (!prevRecord) {
      /* 理论上不可达：operationId 只能来自某次已落盘的提交。真到了说明文件被外部改了。 */
      throw new TaskPlanStoreError('read_failed', '任务日志里找不到这次重放对应的记录')
    }
    return {
      ok: true,
      state: result.state,
      changed: [],
      replayed: true,
      record: prevRecord
    }
  }

  const record: TaskPlanLogRecord = {
    id: result.state.operationId ?? args.request.operationId,
    round: Number.isInteger(args.round) && args.round >= 1 ? args.round : 1,
    at: new Date().toISOString(),
    data: toTaskPlanEntryData(result.state)
  }
  await appendRecord(taskPlanLogPath(args.sessionId, args.opts?.dir), record)
  return { ok: true, state: result.state, changed: result.changed, replayed: false, record }
}

/**
 * 追加一行并**确认它真的落下去了**。
 *
 * 三个动作缺一不可：
 *   · `mkdir -p` —— 首次使用时目录还不存在；
 *   · `write + fsync` —— 只写进 OS 缓存就当成功，掉电就丢（那仍然是「报成功」）；
 *   · 回读最后一行 —— 缓存的失败模式（写到一半 / 被别的进程截断）只有回读能发现。
 */
async function appendRecord(path: string, record: TaskPlanLogRecord): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true })
    const handle = await open(path, 'a')
    try {
      await handle.writeFile(serializeTaskPlanLogRecord(record) + '\n', 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }

    const text = await readFile(path, 'utf8')
    const end = text.endsWith('\n') ? text.length - 1 : text.length
    const lastLine = text.slice(text.lastIndexOf('\n', end - 1) + 1, end)
    const parsed = parseTaskPlanLogLine(lastLine)
    if (!parsed || parsed.data.revision !== record.data.revision) {
      throw new TaskPlanStoreError('write_failed', '任务日志写入后回读校验失败（这一条没有生效）')
    }
  } catch (err) {
    if (err instanceof TaskPlanStoreError) throw err
    throw new TaskPlanStoreError('write_failed', `任务日志写不进去：${describe(err)}`)
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
