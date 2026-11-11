import { CapabilityCommandError, type CapabilityCommandResult } from './capability-server'
import { addTerminalJob, updateTerminalJob } from './terminal-jobs'
import { terminalJobOwnedBy } from '../shared/terminal-jobs'

export const BASH_WATCH_MS = 240_000
const STALE_GRACE_MS = 90_000
const COMMAND_MAX_CHARS = 2000
const NOTICE_MAX_CHARS = 24_000
const ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/
const CLOSED_KEEP = 200

export interface BackgroundBashContext {
  ownerKeys(): string[]
  now(): number
  notify(text: string, stillOwner: () => boolean, wake: boolean): void
}

interface Entry {
  id: string
  jobId: string
  owners: string[]
  stopRequested: boolean
  ended: boolean
  wakeWatchers: Set<() => void>
  staleTimer: ReturnType<typeof setTimeout> | null
}

const stoppers = new Map<string, () => boolean>()

export function stopBackgroundBash(jobId: string): boolean {
  return stoppers.get(jobId)?.() ?? false
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

export class BackgroundBashCommands {
  private readonly entries = new Map<string, Entry>()
  private readonly closed = new Set<string>()

  constructor(
    private readonly ctx: BackgroundBashContext,
    private readonly watchMs: number = BASH_WATCH_MS
  ) {}

  async run(params: Record<string, unknown>, signal?: AbortSignal): Promise<CapabilityCommandResult> {
    const action = text(params.action, 16)
    if (action === 'watch') return this.watch(params, signal)
    if (action === 'end') return this.end(params)
    throw new CapabilityCommandError('bash_background_action', 'action must be watch or end')
  }

  dispose(): void {
    for (const entry of [...this.entries.values()]) this.finish(entry, 'stopped')
  }

  private stillOwner(entry: Entry): () => boolean {
    return () => this.ctx.ownerKeys().some((key) => terminalJobOwnedBy({ owners: entry.owners }, key))
  }

  private requestStop(entry: Entry): boolean {
    if (entry.ended) return false
    entry.stopRequested = true
    updateTerminalJob(entry.jobId, { state: 'stopping' })
    for (const wake of [...entry.wakeWatchers]) wake()
    return true
  }

  private armStale(entry: Entry): void {
    if (entry.staleTimer) clearTimeout(entry.staleTimer)
    entry.staleTimer = setTimeout(() => this.finish(entry, 'stopped'), this.watchMs + STALE_GRACE_MS)
    entry.staleTimer.unref?.()
  }

  private finish(entry: Entry, state: 'completed' | 'stopped'): void {
    if (entry.ended) return
    entry.ended = true
    if (entry.staleTimer) clearTimeout(entry.staleTimer)
    entry.staleTimer = null
    this.entries.delete(entry.id)
    stoppers.delete(entry.jobId)
    updateTerminalJob(entry.jobId, { state, endedAt: this.ctx.now() })
    for (const wake of [...entry.wakeWatchers]) wake()
  }

  private async watch(params: Record<string, unknown>, signal?: AbortSignal): Promise<CapabilityCommandResult> {
    const id = text(params.id, 64)
    if (!ID_PATTERN.test(id)) throw new CapabilityCommandError('bash_background_id', 'invalid id')
    if (this.closed.has(id) || signal?.aborted) return { summary: { kind: 'bash-background', stop: false } }
    let entry = this.entries.get(id)
    if (!entry) {
      const owners = this.ctx.ownerKeys()
      const job = addTerminalJob({
        terminalId: '',
        kind: 'bash',
        owners,
        command: text(params.command, COMMAND_MAX_CHARS),
        cwd: text(params.cwd, 1000),
        startedAt: this.ctx.now()
      })
      entry = { id, jobId: job.id, owners, stopRequested: false, ended: false, wakeWatchers: new Set(), staleTimer: null }
      this.entries.set(id, entry)
      const created = entry
      stoppers.set(job.id, () => this.requestStop(created))
    }
    const active = entry
    if (!active.stopRequested && !signal?.aborted) {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer)
          active.wakeWatchers.delete(done)
          signal?.removeEventListener('abort', done)
          resolve()
        }
        const timer = setTimeout(done, this.watchMs)
        active.wakeWatchers.add(done)
        signal?.addEventListener('abort', done, { once: true })
      })
    }
    if (!active.ended) this.armStale(active)
    return { summary: { kind: 'bash-background', stop: active.stopRequested && !active.ended } }
  }

  private end(params: Record<string, unknown>): CapabilityCommandResult {
    const id = text(params.id, 64)
    this.closed.add(id)
    if (this.closed.size > CLOSED_KEEP) this.closed.delete(this.closed.values().next().value as string)
    const entry = this.entries.get(id)
    if (!entry) return { summary: { kind: 'bash-background', ended: false } }
    const stopped = entry.stopRequested
    const notice = text(params.notice, NOTICE_MAX_CHARS)
    this.finish(entry, stopped ? 'stopped' : 'completed')
    if (stopped && notice) this.ctx.notify(notice, this.stillOwner(entry), false)
    return { summary: { kind: 'bash-background', ended: true, stopped } }
  }
}
