import { isImmediatePhase, type RunSnapshot } from '../../shared/runs'
import type { RunChange } from './registry'

export interface RunUpdatePayload {
  upsert: RunSnapshot[]
  remove: string[]
}

export interface RunPublisherOptions {
  emit: (payload: RunUpdatePayload) => void
  intervalMs?: number
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
}

export class RunPublisher {
  private readonly pending = new Map<string, RunSnapshot>()
  private readonly removals = new Set<string>()
  private handle: unknown = null
  private readonly intervalMs: number
  private readonly schedule: (fn: () => void, ms: number) => unknown
  private readonly cancel: (handle: unknown) => void

  constructor(private readonly options: RunPublisherOptions) {
    this.intervalMs = options.intervalMs ?? 250
    this.schedule = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
    this.cancel = options.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  }

  pushChange(change: RunChange): void {
    for (const snapshot of change.runs) this.push(snapshot, change.immediate)
  }

  push(snapshot: RunSnapshot, immediate = false): void {
    this.pending.set(snapshot.runId, snapshot)
    this.removals.delete(snapshot.runId)
    if (immediate || isImmediatePhase(snapshot.phase)) this.flush()
    else this.scheduleFlush()
  }

  remove(runId: string, immediate = true): void {
    this.pending.delete(runId)
    this.removals.add(runId)
    if (immediate) this.flush()
    else this.scheduleFlush()
  }

  flush(): void {
    if (this.handle !== null) {
      this.cancel(this.handle)
      this.handle = null
    }
    if (this.pending.size === 0 && this.removals.size === 0) return
    const payload: RunUpdatePayload = { upsert: [...this.pending.values()], remove: [...this.removals] }
    this.pending.clear()
    this.removals.clear()
    this.options.emit(payload)
  }

  dispose(): void {
    if (this.handle !== null) {
      this.cancel(this.handle)
      this.handle = null
    }
    this.pending.clear()
    this.removals.clear()
  }

  private scheduleFlush(): void {
    if (this.handle !== null) return
    this.handle = this.schedule(() => {
      this.handle = null
      this.flush()
    }, this.intervalMs)
  }
}
