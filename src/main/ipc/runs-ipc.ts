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
  recovered?: { steering: string[]; followUp: string[] }
}

export interface RunsIpcDeps {
  snapshot(): { revision: number; runs: RunSnapshot[] }
  markSeen(runId: string): { ok: boolean }
  stopSessionRun(target: { sessionId: string; sessionPath?: string }): Promise<RunsStopOutcome>
  stopSubagentRun(runId: string): Promise<RunsStopOutcome>
  root?: string
}

const MAX_LINES_PER_FILE = 20_000
const MAX_LINE_CHARS = 512 * 1024
const MAX_DAYS = 31
const DEFAULT_LIMIT = 500
const MAX_LIMIT = 2000
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

function isRecord(value: unknown): value is RunHistoryRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<RunHistoryRecord>
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

function dayStart(day: string): number | null {
  if (!DAY_RE.test(day)) return null
  const [year, month, date] = day.split('-').map((part) => Number(part))
  if (!year || !month || !date || month < 1 || month > 12 || date < 1 || date > 31) return null
  const at = new Date(year, month - 1, date, 12, 0, 0, 0)
  if (at.getFullYear() !== year || at.getMonth() !== month - 1 || at.getDate() !== date) return null
  return at.getTime()
}

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

function findActiveRun(deps: RunsIpcDeps, runId: string): RunSnapshot | null {
  const run = deps.snapshot().runs.find((item) => item.runId === runId)
  if (!run || isTerminalPhase(run.phase)) return null
  return run
}

export function registerRunsIpc(ipc: IpcRegistrar, deps: RunsIpcDeps): void {
  const { handle } = ipc
  const root = deps.root ?? YAN_DIR

  handle('yan:runs:snapshot', async () => deps.snapshot())
  handle('yan:runs:markSeen', async (runId: unknown) => deps.markSeen(typeof runId === 'string' ? runId : ''))

  handle('yan:runs:history', async (query: RunsHistoryQuery) => readRunsHistory(query ?? {}, root))

  handle('yan:runs:stop', async (runId: unknown): Promise<RunsStopResult> => {
    const id = typeof runId === 'string' ? runId.trim() : ''
    if (!id) return { ok: false, error: '缺少运行编号' }
    const run = findActiveRun(deps, id)
    if (!run) return { ok: false, error: '这次运行不在当前登记表里，或已经结束', runId: id }
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

export function resolveHistoryDays(query: RunsHistoryQuery): { days: string[]; error?: string } {
  return resolveDays(query)
}
