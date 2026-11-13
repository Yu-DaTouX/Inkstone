import { pick, uiLang } from '../shared/ui-lang'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UtilityProcess } from 'electron'
import { runGitReadOp } from './git-read-ops'
import type { GitReadOp, GitReadReplies, GitReadRequestOf } from './git-read-ops'
import type { AuthorizeReadCwd } from './git-inspect'

const IDLE_EXIT_MS = 30_000
const REQUEST_TIMEOUT_MS = 120_000
const FAILURES_BEFORE_PAUSE = 3
const PAUSE_MS = 60_000

class WorkerExitError extends Error {}
class WorkerTimeoutError extends WorkerExitError {}

interface Pending {
  owner: UtilityProcess
  authorize: AuthorizeReadCwd
  settle: (value: unknown) => void
  fail: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const pending = new Map<string, Pending>()
let child: UtilityProcess | null = null
let starting: Promise<UtilityProcess> | null = null
let generation = 0
let idleTimer: ReturnType<typeof setTimeout> | undefined
let failures = 0
let pausedUntil = 0

const exitedMessage = (): string => pick('Git 查询进程已退出', 'Git query process exited')

export function gitReadHostEnabled(): boolean {
  return process.env.YAN_GIT_READ_HOST !== '0' && Date.now() >= pausedUntil
}

function workerPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'git-read-worker.js')
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function failOwned(owner: UtilityProcess | null, error: () => Error): void {
  for (const [id, entry] of [...pending]) {
    if (owner && entry.owner !== owner) continue
    pending.delete(id)
    clearTimeout(entry.timer)
    entry.fail(error())
  }
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

function post(proc: UtilityProcess, message: unknown): void {
  try {
    proc.postMessage(message)
  } catch {
  }
}

function answerAuthorize(proc: UtilityProcess, id: string, entry: Pending, ask: { key?: unknown; cwd?: unknown }): void {
  const key = String(ask.key ?? '')
  void Promise.resolve()
    .then(() => entry.authorize(String(ask.cwd ?? '')))
    .then(
      (value) => post(proc, { kind: 'authorized', id, key, value }),
      (error: unknown) => post(proc, { kind: 'authorized', id, key, failed: true, error: errorText(error) })
    )
}

function onMessage(proc: UtilityProcess, message: { id?: unknown; value?: unknown; failed?: unknown; error?: unknown; authorize?: unknown } | null): void {
  if (!message || typeof message.id !== 'string') return
  const entry = pending.get(message.id)
  if (!entry || entry.owner !== proc) return
  if (message.authorize && typeof message.authorize === 'object') {
    answerAuthorize(proc, message.id, entry, message.authorize as { key?: unknown; cwd?: unknown })
    return
  }
  pending.delete(message.id)
  clearTimeout(entry.timer)
  if (message.failed === true) entry.fail(new Error(String(message.error ?? '')))
  else entry.settle(message.value)
  armIdle()
}

async function ensureChild(): Promise<UtilityProcess> {
  if (child) return child
  if (starting) return starting
  const launch = (async () => {
    const born = generation
    const { utilityProcess } = await import('electron')
    if (born !== generation) throw new Error(exitedMessage())
    const spawned = utilityProcess.fork(workerPath(), [], { serviceName: 'Inkstone git', stdio: 'ignore' })
    spawned.on('message', (message) => onMessage(spawned, message))
    spawned.once('exit', () => {
      if (child === spawned) child = null
      failOwned(spawned, () => new WorkerExitError(exitedMessage()))
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

function requestFromWorker(proc: UtilityProcess, request: GitReadRequestOf<GitReadOp>, authorize: AuthorizeReadCwd): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = randomUUID()
    clearTimeout(idleTimer)
    const timer = setTimeout(() => {
      if (!pending.delete(id)) return
      reject(new WorkerTimeoutError(exitedMessage()))
      if (child === proc) stopChild()
    }, REQUEST_TIMEOUT_MS)
    pending.set(id, { owner: proc, authorize, settle: resolve, fail: reject, timer })
    try {
      proc.postMessage({ kind: 'read', id, request, env: { ...process.env }, lang: uiLang() })
    } catch (error) {
      pending.delete(id)
      clearTimeout(timer)
      armIdle()
      reject(new WorkerExitError(errorText(error)))
    }
  })
}

function noteFailure(): void {
  failures += 1
  if (failures < FAILURES_BEFORE_PAUSE) return
  failures = 0
  pausedUntil = Date.now() + PAUSE_MS
}

export async function runGitRead<K extends GitReadOp>(request: GitReadRequestOf<K>, authorize: AuthorizeReadCwd): Promise<GitReadReplies[K]> {
  if (!gitReadHostEnabled()) return runGitReadOp(request, authorize)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let proc: UtilityProcess
    try {
      proc = await ensureChild()
    } catch {
      noteFailure()
      break
    }
    try {
      const value = await requestFromWorker(proc, request, authorize)
      failures = 0
      return value as GitReadReplies[K]
    } catch (error) {
      if (!(error instanceof WorkerExitError)) throw error
      noteFailure()
      if (error instanceof WorkerTimeoutError || !gitReadHostEnabled()) break
    }
  }
  return runGitReadOp(request, authorize)
}

export function disposeGitReadHost(): void {
  generation++
  stopChild()
  failOwned(null, () => new Error(exitedMessage()))
}
