import { utilityProcess, type UtilityProcess } from 'electron'
import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FileNameSearchRequest, FileNameSearchResult } from '../shared/file-name-search'
import { killPidTree } from './git-service'
import { LatestPerScopeScheduler } from './file-name-scheduler'
import { MAX_NAME_RESULTS } from './file-name-search-core'

interface NameJob {
  root: string
  query: string
  limit: number
}

interface WorkerReply {
  id: string
  matches?: FileNameSearchResult['matches']
  truncated?: boolean
  source?: FileNameSearchResult['source']
  scanned?: number
  cancelled?: boolean
  error?: string
}

interface Slot {
  proc: UtilityProcess
  pending: number
}

const MAX_WORKERS = 2
const slots = new Set<Slot>()

function workerPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'file-name-search-worker.js')
}

function spawnSlot(): Slot {
  const proc = utilityProcess.fork(workerPath(), [], { serviceName: 'Inkstone file name search', stdio: 'ignore' })
  const slot: Slot = { proc, pending: 0 }
  proc.once('exit', () => slots.delete(slot))
  slots.add(slot)
  return slot
}

function acquireSlot(): Slot {
  let best: Slot | null = null
  for (const slot of slots) if (!best || slot.pending < best.pending) best = slot
  if (best && (best.pending === 0 || slots.size >= MAX_WORKERS)) return best
  return spawnSlot()
}

function killSlot(slot: Slot): void {
  slots.delete(slot)
  killPidTree(slot.proc.pid, () => slot.proc.kill())
}

function runInWorker(job: NameJob, signal: AbortSignal): Promise<WorkerReply> {
  const slot = acquireSlot()
  const id = randomUUID()
  slot.pending += 1
  return new Promise<WorkerReply>((resolve, reject) => {
    const cleanup = (): void => {
      slot.proc.off('message', onMessage)
      slot.proc.off('exit', onExit)
      signal.removeEventListener('abort', onAbort)
    }
    const onMessage = (message: WorkerReply): void => {
      if (!message || message.id !== id) return
      slot.pending = Math.max(0, slot.pending - 1)
      cleanup()
      resolve(message)
    }
    const onExit = (): void => {
      cleanup()
      reject(new Error('文件名搜索进程已退出'))
    }
    const onAbort = (): void => {
      cleanup()
      if (signal.reason === 'timeout' || signal.reason === 'disposed') killSlot(slot)
      else {
        slot.proc.postMessage({ type: 'cancel', id })
        slot.pending = Math.max(0, slot.pending - 1)
      }
      reject(new Error(String(signal.reason ?? 'aborted')))
    }
    slot.proc.on('message', onMessage)
    slot.proc.once('exit', onExit)
    signal.addEventListener('abort', onAbort, { once: true })
    slot.proc.postMessage({ type: 'search', id, root: job.root, query: job.query, limit: job.limit })
  })
}

const scheduler = new LatestPerScopeScheduler<NameJob, WorkerReply>(runInWorker, { concurrency: 2, queueLimit: 2, deadlineMs: 4000 })

export async function searchFileNames(scope: string, request: FileNameSearchRequest): Promise<FileNameSearchResult> {
  const empty = (error?: FileNameSearchResult['error']): FileNameSearchResult => ({
    request,
    matches: [],
    truncated: false,
    source: 'none',
    scanned: 0,
    ...(error ? { error } : {})
  })
  let root: string
  try {
    root = await realpath(request.cwd)
    if (!(await stat(root)).isDirectory()) return empty({ code: 'invalid' })
  } catch {
    return empty({ code: 'invalid' })
  }
  const limit = Math.max(1, Math.min(MAX_NAME_RESULTS, Math.floor(request.limit ?? MAX_NAME_RESULTS)))
  const outcome = await scheduler.submit(scope, { root, query: String(request.query ?? '').slice(0, 512), limit })
  if (!outcome.ok) return empty({ code: outcome.code, ...(outcome.message ? { message: outcome.message } : {}) })
  const reply = outcome.value
  if (reply.cancelled) return empty({ code: 'superseded' })
  if (reply.error) return empty({ code: 'failed', message: reply.error })
  return {
    request,
    matches: reply.matches ?? [],
    truncated: reply.truncated === true,
    source: reply.source ?? 'none',
    scanned: reply.scanned ?? 0
  }
}

export function disposeFileNameSearch(): void {
  scheduler.dispose()
  for (const slot of [...slots]) killSlot(slot)
}
