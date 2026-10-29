import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UtilityProcess } from 'electron'
import type { GrepJob, GrepPage, NameJob, NamePage } from './file-search-index'

export type FileSearchJob = ({ kind: 'name' } & NameJob) | ({ kind: 'grep' } & GrepJob)

export interface FileSearchReply {
  name: NamePage
  grep: GrepPage
}

interface Pending {
  settle: (value: unknown) => void
  fail: (error: Error) => void
  detach: () => void
}

const pending = new Map<string, Pending>()
let child: UtilityProcess | null = null
let starting: Promise<UtilityProcess> | null = null

function workerPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'file-search-worker.js')
}

function failAll(message: string): void {
  const entries = [...pending.values()]
  pending.clear()
  for (const entry of entries) {
    entry.detach()
    entry.fail(new Error(message))
  }
}

function onMessage(message: { id?: unknown; value?: unknown; error?: unknown } | null): void {
  if (!message || typeof message.id !== 'string') return
  const entry = pending.get(message.id)
  if (!entry) return
  pending.delete(message.id)
  entry.detach()
  if (typeof message.error === 'string' && message.error) entry.fail(new Error(message.error))
  else entry.settle(message.value)
}

function safeKill(proc: UtilityProcess): void {
  try {
    proc.kill()
  } catch {
  }
}

function killChild(): void {
  const victim = child
  const inFlight = starting
  child = null
  starting = null
  if (inFlight) inFlight.then((proc) => (child === proc ? undefined : safeKill(proc))).catch(() => undefined)
  if (victim) safeKill(victim)
  failAll('搜索进程已退出')
}

async function ensureChild(): Promise<UtilityProcess> {
  if (child) return child
  if (starting) return starting
  starting = (async () => {
    const { utilityProcess } = await import('electron')
    const spawned = utilityProcess.fork(workerPath(), [], { serviceName: 'Inkstone file search', stdio: 'ignore' })
    spawned.on('message', onMessage)
    spawned.once('exit', () => {
      if (child === spawned) {
        child = null
        starting = null
      }
      failAll('搜索进程已退出')
    })
    child = spawned
    return spawned
  })()
  try {
    return await starting
  } catch (error) {
    starting = null
    throw error
  }
}

export function runFileSearchJob<K extends keyof FileSearchReply>(
  job: FileSearchJob & { kind: K },
  signal: AbortSignal
): Promise<FileSearchReply[K]> {
  return ensureChild().then(
    (proc) =>
      new Promise<FileSearchReply[K]>((resolve, reject) => {
        const id = randomUUID()
        const onAbort = (): void => {
          pending.delete(id)
          const reason = String(signal.reason ?? 'aborted')
          if (reason === 'timeout' || reason === 'disposed') killChild()
          reject(new Error(reason))
        }
        if (signal.aborted) {
          onAbort()
          return
        }
        pending.set(id, {
          settle: (value) => resolve(value as FileSearchReply[K]),
          fail: reject,
          detach: () => signal.removeEventListener('abort', onAbort)
        })
        signal.addEventListener('abort', onAbort, { once: true })
        proc.postMessage({ ...job, id })
      })
  )
}

export function disposeFileSearch(): void {
  killChild()
}
