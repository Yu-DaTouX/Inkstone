/**
 * 运行注册表与运行历史的 IPC 适配（`yan:runs:*`，v3 WP-10 / WP-54）。
 *
 * 与 `runs-host.ts` 的分工：host 负责把 pi 事件旁路归约成快照并推送；本文件只把
 * 它已有的读接口（snapshot / markSeen）接到 registrar 上，并提供两件总览页要用的
 * 新能力：
 *
 *   · `yan:runs:history` —— 读 `YAN_DIR/runs/YYYY-MM-DD.jsonl`。**有界读取**：
 *     单文件最多读 `MAX_LINES_PER_FILE` 行、单行过长直接跳过、日期最多 31 天；
 *     坏行 / IO 失败不让整次调用失败（坏行跳过，IO 失败记 `failures`）。
 *   · `yan:runs:stop` —— 只允许停止**当前登记且仍在运行**的那一次运行。
 *     真正的停止动作由宿主注入（`stopSessionRun` / `stopSubagentRun`），
 *     会话运行必须走界面停止按钮同一条 `AgentController.abort()` 路径，
 *     不在这里新造模型循环，也不跳过 clear_queue 语义。
 *
 * 依赖以窄接口注入：本文件不 import Electron，也不 import 主进程入口，
 * 因此可以用临时 `YAN_DIR` fixture 直接单测（见 scripts/test-v3-runs-ipc.mjs）。
 */
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import type { IpcRegistrar } from './registrar'
import { runHistoryPath } from '../runs/history'
import type { RunHistoryRecord } from '../runs/history'
import { YAN_DIR } from '../paths'
import { isTerminalPhase } from '../../shared/runs'
import type { RunSnapshot } from '../../shared/runs'
import type {
  RunsHistoryQuery,
  RunsHistoryResult,
  RunsStopResult
} from '../../shared/ipc'

export interface RunsStopOutcome {
  ok: boolean
  error?: string
  /**
   * 停止会话运行时 pi `abort()` 先 clear_queue 拿回的排队文本。
   * 宿主必须原样交回渲染端（放回输入框），不能在这里丢掉。
   */
  recovered?: { steering: string[]; followUp: string[] }
}

export interface RunsIpcDeps {
  /** 当前登记的运行快照（未就绪时返回空表）；总是先 flush 待发增量。 */
  snapshot(): { revision: number; runs: RunSnapshot[] }
  /** 标记某次运行已读；返回它此前是否已登记。 */
  markSeen(runId: string): { ok: boolean }
  /**
   * 停止一个仍在运行的会话运行。宿主必须复用界面停止按钮的正式路径
   * （`AgentController.abort()`：先 clear_queue 再 abort）；本层只按运行快照
   * 找到对应实例，不自己发 pi 命令。
   */
  stopSessionRun(target: { sessionId: string; sessionPath?: string }): Promise<RunsStopOutcome>
  /**
   * 停止一个子 Agent 运行：复用现有子代理 stop（按运行 id 找子代理）。
   */
  stopSubagentRun(runId: string): Promise<RunsStopOutcome>
  /** 数据根目录（运行历史 jsonl 所在）；缺省 `YAN_DIR`。 */
  root?: string
}

/** 单日文件最多读多少行；超过即截断，不把整文件读进内存。 */
const MAX_LINES_PER_FILE = 20_000
/** 单行字符上限；超过直接跳过（防止一行坏数据吃掉内存）。 */
const MAX_LINE_CHARS = 512 * 1024
/** 一次调用最多覆盖多少个日期分片。 */
const MAX_DAYS = 31
const DEFAULT_LIMIT = 500
const MAX_LIMIT = 2000
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

function isRecord(value: unknown): value is RunHistoryRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<RunHistoryRecord>
  /* 只检查总览会直接读的字段；形状不全的行按坏行跳过，不让 undefined 漏到界面。 */
  return (
    typeof record.runId === 'string' &&
    record.runId.length > 0 &&
    typeof record.code === 'string' &&
    typeof record.kind === 'string' &&
    typeof record.sessionId === 'string' &&
    typeof record.title === 'string' &&
    typeof record.endedAt === 'number' &&
    Number.isFinite(record.endedAt) &&
    (record.terminal === 'done' || record.terminal === 'stopped' || record.terminal === 'failed') &&
    Array.isArray(record.segments) &&
    typeof record.counts === 'object' &&
    record.counts !== null
  )
}

/** `YYYY-MM-DD` → 本地当天正午的时间戳；非法输入返回 null。 */
function dayStart(day: string): number | null {
  if (!DAY_RE.test(day)) return null
  const [year, month, date] = day.split('-').map((part) => Number(part))
  if (!year || !month || !date || month < 1 || month > 12 || date < 1 || date > 31) return null
  const at = new Date(year, month - 1, date, 12, 0, 0, 0)
  if (at.getFullYear() !== year || at.getMonth() !== month - 1 || at.getDate() !== date) return null
  return at.getTime()
}

/** 把查询解析成要读的日期分片（升序），非法输入返回可读错误。 */
function resolveDays(query: RunsHistoryQuery): { days: string[]; error?: string } {
  const date = typeof query.date === 'string' && query.date ? query.date : undefined
  const range = query.range && typeof query.range === 'object' ? query.range : undefined
  if (date && range) return { days: [], error: 'date 与 range 只能给一个' }

  if (date) {
    if (dayStart(date) === null) return { days: [], error: `日期格式不对：${date}` }
    return { days: [date] }
  }

  if (range) {
    const from = String(range.from ?? '')
    const to = range.to ? String(range.to) : from
    const fromAt = dayStart(from)
    const toAt = dayStart(to)
    if (fromAt === null) return { days: [], error: `起始日期格式不对：${from}` }
    if (toAt === null) return { days: [], error: `结束日期格式不对：${to}` }
    const lo = Math.min(fromAt, toAt)
    const hi = Math.max(fromAt, toAt)
    const days: string[] = []
    /* 按天步进（本地时间）；跨 DST 时用正午推进，日期不会漂。 */
    for (let cursor = new Date(lo); cursor.getTime() <= hi; cursor.setDate(cursor.getDate() + 1)) {
      days.push(
        `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`
      )
      if (days.length > MAX_DAYS) return { days: [], error: `一次最多读 ${MAX_DAYS} 天` }
    }
    return { days }
  }

  const today = new Date()
  return {
    days: [
      `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    ]
  }
}

function matchesFilters(record: RunHistoryRecord, filters: RunsHistoryQuery['filters']): boolean {
  if (!filters) return true
  if (filters.terminal?.length && !filters.terminal.includes(record.terminal)) return false
  if (filters.kind?.length && !filters.kind.includes(record.kind)) return false
  if (filters.projectId && record.projectId !== filters.projectId) return false
  if (filters.sessionId && record.sessionId !== filters.sessionId) return false
  if (filters.model && record.model?.id !== filters.model) return false
  if (filters.query) {
    const needle = filters.query.toLowerCase()
    if (!record.title.toLowerCase().includes(needle) && !record.code.toLowerCase().includes(needle)) return false
  }
  return true
}

async function readDay(
  path: string
): Promise<{ records: RunHistoryRecord[]; truncated: boolean; missing: boolean; error?: string }> {
  const records: RunHistoryRecord[] = []
  let truncated = false
  let lines = 0
  let missing = false

  const stream = createReadStream(path, { encoding: 'utf8' })
  const reader = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of reader) {
      if (!line || !line.trim()) continue
      lines += 1
      if (lines > MAX_LINES_PER_FILE) {
        truncated = true
        break
      }
      if (line.length > MAX_LINE_CHARS) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        /* 坏行跳过：历史只是索引，单行损坏不该让总览整页失败。 */
        continue
      }
      if (isRecord(parsed)) records.push(parsed)
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ENOENT') missing = true
    else return { records, truncated, missing, error: error instanceof Error ? error.message : String(error) }
  } finally {
    reader.close()
    stream.destroy()
  }
  return { records, truncated, missing }
}

/**
 * 读一天或多天的运行历史。纯函数 + IO：不依赖 Electron，测试可直接调用。
 * 返回按 `endedAt` 倒序，最多 `limit` 条。
 */
export async function readRunsHistory(
  query: RunsHistoryQuery,
  root: string = YAN_DIR
): Promise<RunsHistoryResult> {
  const resolved = resolveDays(query ?? {})
  if (resolved.error) return { ok: false, error: resolved.error, records: [], days: [], truncated: false }

  const limit = Math.min(Math.max(1, Math.trunc(query?.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT), MAX_LIMIT)
  const records: RunHistoryRecord[] = []
  const failures: { day: string; error: string }[] = []
  let truncated = false

  for (const day of resolved.days) {
    /* 复用写入端的分片命名，避免两处各写一份 `runs/<date>.jsonl`。 */
    const at = dayStart(day)
    if (at === null) continue
    const path = runHistoryPath(at, root)
    const result = await readDay(path)
    if (result.missing) continue
    if (result.error) {
      failures.push({ day, error: result.error })
      continue
    }
    if (result.truncated) truncated = true
    for (const record of result.records) {
      if (matchesFilters(record, query?.filters)) records.push(record)
    }
  }

  records.sort((a, b) => b.endedAt - a.endedAt)
  const sliced = records.length > limit
  return {
    ok: true,
    records: sliced ? records.slice(0, limit) : records,
    days: resolved.days,
    truncated: truncated || sliced,
    ...(failures.length ? { failures } : {})
  }
}

/** 从快照里按 runId 找仍在运行的那一条；找不到或已终态返回 null。 */
function findActiveRun(deps: RunsIpcDeps, runId: string): RunSnapshot | null {
  const run = deps.snapshot().runs.find((item) => item.runId === runId)
  if (!run || isTerminalPhase(run.phase)) return null
  return run
}

export function registerRunsIpc(ipc: IpcRegistrar, deps: RunsIpcDeps): void {
  const { handle } = ipc
  const root = deps.root ?? YAN_DIR

  /*
   * snapshot 必须**先 flush** 待发增量再返回，使返回的 revision 与刚推送的
   * 那一帧一致；渲染端先订阅、再取快照，随后只回放 revision 更大的增量。
   * runsHost 在 registerIpc 之后才初始化，所以这里惰性读取，未就绪返回空快照。
   */
  handle('yan:runs:snapshot', async () => deps.snapshot())
  handle('yan:runs:markSeen', async (runId: unknown) => deps.markSeen(typeof runId === 'string' ? runId : ''))

  handle('yan:runs:history', async (query: RunsHistoryQuery) => readRunsHistory(query ?? {}, root))

  handle('yan:runs:stop', async (runId: unknown): Promise<RunsStopResult> => {
    const id = typeof runId === 'string' ? runId.trim() : ''
    if (!id) return { ok: false, error: '缺少运行编号' }
    const run = findActiveRun(deps, id)
    if (!run) return { ok: false, error: '这次运行不在当前登记表里，或已经结束', runId: id }
    /* 只停已登记、仍在运行的运行；不碰窗口不可见的其它宿主对象。 */
    if (run.kind === 'subagent') {
      const result = await deps.stopSubagentRun(id)
      return result.ok ? { ok: true, runId: id, kind: run.kind } : { ok: false, error: result.error, runId: id }
    }
    if (run.kind !== 'session') {
      return { ok: false, error: '这种运行暂不支持在这里停止', runId: id, kind: run.kind }
    }
    const result = await deps.stopSessionRun({ sessionId: run.sessionId, ...(run.sessionPath ? { sessionPath: run.sessionPath } : {}) })
    return result.ok
      ? { ok: true, runId: id, kind: run.kind, ...(result.recovered ? { recovered: result.recovered } : {}) }
      : { ok: false, error: result.error, runId: id }
  })
}

/** 只用于内部测试的可读日期构造（导出给单测复用同一套规则）。 */
export function resolveHistoryDays(query: RunsHistoryQuery): { days: string[]; error?: string } {
  return resolveDays(query)
}
