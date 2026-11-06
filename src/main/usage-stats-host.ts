import { pick } from '../shared/ui-lang'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UtilityProcess } from 'electron'
import type { UsageRange, UsageStatsView } from '../shared/usage-stats'
import { readUsageStats } from './usage-stats'

type UsageReply = UsageStatsView & { userName: string }

const IDLE_EXIT_MS = 30_000

const pending = new Map<string, { settle: (value: UsageReply) => void; fail: (error: Error) => void }>()
let child: UtilityProcess | null = null
let starting: Promise<UtilityProcess> | null = null
let generation = 0
let idleTimer: ReturnType<typeof setTimeout> | undefined

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
      if (child !== spawned) return
      child = null
      failAll(pick('用量统计进程已退出', 'Usage stats process exited'))
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

function readInWorker(range: UsageRange): Promise<UsageReply> {
  return ensureChild().then(
    (proc) =>
      new Promise<UsageReply>((resolve, reject) => {
        const id = randomUUID()
        clearTimeout(idleTimer)
        pending.set(id, { settle: resolve, fail: reject })
        proc.postMessage({ id, range })
      })
  )
}

export function readUsageStatsOffThread(range: UsageRange): Promise<UsageReply> {
  return readInWorker(range).catch(() => readUsageStats(range))
}

export function disposeUsageStatsWorker(): void {
  generation++
  stopChild()
  failAll(pick('用量统计进程已退出', 'Usage stats process exited'))
}
