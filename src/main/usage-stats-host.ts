import { pick } from '../shared/ui-lang'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UtilityProcess } from 'electron'
import type { UsageRange, UsageStatsView } from '../shared/usage-stats'
import { readUsageStats } from './usage-stats'

type UsageReply = UsageStatsView & { userName: string }

const IDLE_EXIT_MS = 30_000
const FALLBACK_MIN_INTERVAL_MS = 15_000

class WorkerExitError extends Error {}

const pending = new Map<string, { owner: UtilityProcess; settle: (value: UsageReply) => void; fail: (error: Error) => void }>()
let child: UtilityProcess | null = null
let starting: Promise<UtilityProcess> | null = null
let generation = 0
let idleTimer: ReturnType<typeof setTimeout> | undefined
const lastGood = new Map<UsageRange, UsageReply>()
const fallbackFlights = new Map<UsageRange, Promise<UsageReply>>()
const fallbackFinishedAt = new Map<UsageRange, number>()

function workerPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'usage-stats-worker.js')
}

function failAll(message: string): void {
  const entries = [...pending.values()]
  pending.clear()
  for (const entry of entries) entry.fail(new Error(message))
}

function stopChild(): void {
  const victim = child
  child = null
  clearTimeout(idleTimer)
  idleTimer = undefined
  if (victim) {
    try {
      victim.kill()
    } catch {
    }
  }
}

function armIdle(): void {
  clearTimeout(idleTimer)
  if (pending.size) return
  idleTimer = setTimeout(stopChild, IDLE_EXIT_MS)
}

async function ensureChild(): Promise<UtilityProcess> {
  if (child) return child
  if (starting) return starting
  const launch = (async () => {
    const born = generation
    const { utilityProcess } = await import('electron')
    if (born !== generation) throw new Error(pick('用量统计进程已退出', 'Usage stats process exited'))
    const spawned = utilityProcess.fork(workerPath(), [], { serviceName: 'Inkstone usage stats', stdio: 'ignore' })
    spawned.on('message', (message: { id?: unknown; value?: unknown; error?: unknown } | null) => {
      if (!message || typeof message.id !== 'string') return
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      if (typeof message.error === 'string' && message.error) entry.fail(new Error(message.error))
      else entry.settle(message.value as UsageReply)
      armIdle()
    })
    spawned.once('exit', () => {
      if (child === spawned) child = null
      for (const [id, entry] of [...pending]) {
        if (entry.owner !== spawned) continue
        pending.delete(id)
        entry.fail(new WorkerExitError(pick('用量统计进程已退出', 'Usage stats process exited')))
      }
    })
    child = spawned
    return spawned
  })()
  starting = launch
  try {
    return await launch
  } finally {
    if (starting === launch) starting = null
  }
}

function requestFromWorker(proc: UtilityProcess, range: UsageRange): Promise<UsageReply> {
  return new Promise<UsageReply>((resolve, reject) => {
    const id = randomUUID()
    clearTimeout(idleTimer)
    pending.set(id, { owner: proc, settle: resolve, fail: reject })
    try {
      proc.postMessage({ id, range })
    } catch (error) {
      pending.delete(id)
      armIdle()
      reject(new WorkerExitError(error instanceof Error ? error.message : String(error)))
    }
  })
}

function scanInMainProcess(range: UsageRange): Promise<UsageReply> {
  const flight = fallbackFlights.get(range)
  if (flight) return flight
  const recent = lastGood.get(range)
  const finished = fallbackFinishedAt.get(range)
  if (recent && finished !== undefined && Date.now() - finished < FALLBACK_MIN_INTERVAL_MS) return Promise.resolve(recent)
  const task = readUsageStats(range)
    .then((value) => {
      lastGood.set(range, value)
      return value
    })
    .finally(() => {
      fallbackFinishedAt.set(range, Date.now())
      if (fallbackFlights.get(range) === task) fallbackFlights.delete(range)
    })
  fallbackFlights.set(range, task)
  return task
}

export async function readUsageStatsOffThread(range: UsageRange): Promise<UsageReply> {
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let proc: UtilityProcess
    try {
      proc = await ensureChild()
    } catch {
      return scanInMainProcess(range)
    }
    try {
      const value = await requestFromWorker(proc, range)
      lastGood.set(range, value)
      return value
    } catch (error) {
      lastError = error
      if (!(error instanceof WorkerExitError)) break
    }
  }
  const previous = lastGood.get(range)
  if (previous) return previous
  throw lastError
}

export function disposeUsageStatsWorker(): void {
  generation++
  stopChild()
  failAll(pick('用量统计进程已退出', 'Usage stats process exited'))
}
