import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { YAN_DIR } from './paths'
import { isSafeSessionId } from './session-id'
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

export function taskPlanDir(dir?: string): string {
  return dir ?? join(YAN_DIR, TASK_PLAN_DIRNAME)
}

export function taskPlanLogPath(sessionId: string, dir?: string): string {
  if (!isSafeSessionId(sessionId)) {
    throw new TaskPlanStoreError('bad_session_id', `会话 id 不合法，不能作为任务日志文件名：${sessionId}`)
  }
  return join(taskPlanDir(dir), `${sessionId}.jsonl`)
}

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
  dir?: string
}

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

export async function currentTaskPlan(
  sessionId: string,
  opts: TaskPlanStoreOptions = {}
): Promise<{ state: TaskPlanState; record: TaskPlanLogRecord | null }> {
  const records = await readTaskPlanLog(sessionId, opts)
  const last = records[records.length - 1]
  if (!last) return { state: emptyTaskPlan(), record: null }
  const stored = readTaskPlanEntry(last.data)
  if (!stored) return { state: emptyTaskPlan(), record: null }
  return { state: planStateOf(stored), record: last }
}

export interface ApplyTaskPlanArgs {
  sessionId: string
  round: number
  request: TaskPlanRequest
  opts?: TaskPlanStoreOptions
}

export type ApplyTaskPlanOutcome =
  | {
      ok: true
      state: TaskPlanState
      changed: TaskChange[]
      replayed: boolean
      record: TaskPlanLogRecord
    }
  | { ok: false; code: TaskErrorCode; message: string }

const tails = new Map<string, Promise<unknown>>()

export function applyTaskPlanOperation(args: ApplyTaskPlanArgs): Promise<ApplyTaskPlanOutcome> {
  const tail = tails.get(args.sessionId) ?? Promise.resolve()
  const next = tail.then(
    () => applyUnlocked(args),
    () => applyUnlocked(args)
  )
  const settled = next.then(() => undefined, () => undefined)
  tails.set(args.sessionId, settled)
  void settled.then(() => {
    if (tails.get(args.sessionId) === settled) tails.delete(args.sessionId)
  })
  return next
}

async function applyUnlocked(args: ApplyTaskPlanArgs): Promise<ApplyTaskPlanOutcome> {
  const { state: prev, record: prevRecord } = await currentTaskPlan(args.sessionId, args.opts ?? {})

  const result = applyTaskRequest(prev, args.request)
  if (!result.ok) return result

  if (result.replayed) {
    if (!prevRecord) {
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

async function appendRecord(path: string, record: TaskPlanLogRecord): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true })
    const previous = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return ''
      throw error
    })
    const prefix = previous.length > 0 && !previous.endsWith('\n') ? '\n' : ''
    const line = serializeTaskPlanLogRecord(record)
    const handle = await open(path, 'a')
    try {
      await handle.writeFile(prefix + line + '\n', 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }

    const text = await readFile(path, 'utf8')
    const writtenAt = text.lastIndexOf(line)
    const parsed = writtenAt >= 0 ? parseTaskPlanLogLine(text.slice(writtenAt, writtenAt + line.length)) : null
    if (!parsed || parsed.data.revision !== record.data.revision) {
      throw new TaskPlanStoreError('write_failed', '任务日志写入后回读校验失败（这一条没有生效）')
    }
    await compactTaskPlanLog(path)
  } catch (err) {
    if (err instanceof TaskPlanStoreError) throw err
    throw new TaskPlanStoreError('write_failed', `任务日志写不进去：${describe(err)}`)
  }
}

const TASK_PLAN_LOG_MAX_BYTES = 8 * 1024 * 1024
const TASK_PLAN_LOG_KEEP_RECORDS = 500

async function compactTaskPlanLog(path: string): Promise<void> {
  const text = await readFile(path, 'utf8')
  if (Buffer.byteLength(text, 'utf8') <= TASK_PLAN_LOG_MAX_BYTES) return
  const lines = text.split('\n').filter((line) => !!parseTaskPlanLogLine(line))
  const kept: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && kept.length < TASK_PLAN_LOG_KEEP_RECORDS; i--) {
    const size = Buffer.byteLength(lines[i] + '\n', 'utf8')
    if (kept.length && bytes + size > TASK_PLAN_LOG_MAX_BYTES) break
    kept.push(lines[i])
    bytes += size
  }
  const temp = `${path}.${process.pid}.${Date.now()}.compact.tmp`
  const handle = await open(temp, 'w')
  try {
    await handle.writeFile(kept.reverse().join('\n') + '\n', 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
