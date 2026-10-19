export type ScheduledFailure = 'superseded' | 'busy' | 'timeout' | 'failed'

export type ScheduledOutcome<R> = { ok: true; value: R } | { ok: false; code: ScheduledFailure; message?: string }

export type ScheduledRunner<J, R> = (job: J, signal: AbortSignal) => Promise<R>

export interface SchedulerOptions {
  concurrency?: number
  queueLimit?: number
  deadlineMs?: number
}

interface Entry<J, R> {
  scope: string
  job: J
  controller: AbortController
  settle: (outcome: ScheduledOutcome<R>) => void
  settled: boolean
  timer: ReturnType<typeof setTimeout> | null
}

export class LatestPerScopeScheduler<J, R> {
  private readonly concurrency: number
  private readonly queueLimit: number
  private readonly deadlineMs: number
  private readonly queue: Entry<J, R>[] = []
  private readonly running = new Set<Entry<J, R>>()
  private readonly byScope = new Map<string, Entry<J, R>>()

  constructor(private readonly runner: ScheduledRunner<J, R>, options: SchedulerOptions = {}) {
    this.concurrency = options.concurrency ?? 2
    this.queueLimit = options.queueLimit ?? 2
    this.deadlineMs = options.deadlineMs ?? 4000
  }

  submit(scope: string, job: J): Promise<ScheduledOutcome<R>> {
    const previous = this.byScope.get(scope)
    if (previous) this.finish(previous, { ok: false, code: 'superseded' }, 'superseded')
    return new Promise((resolve) => {
      const entry: Entry<J, R> = {
        scope,
        job,
        controller: new AbortController(),
        settle: resolve,
        settled: false,
        timer: null
      }
      if (this.running.size < this.concurrency) {
        this.byScope.set(scope, entry)
        this.start(entry)
        return
      }
      if (this.queue.length >= this.queueLimit) {
        entry.settled = true
        resolve({ ok: false, code: 'busy' })
        return
      }
      this.byScope.set(scope, entry)
      this.queue.push(entry)
    })
  }

  stats(): { running: number; queued: number } {
    return { running: this.running.size, queued: this.queue.length }
  }

  dispose(): void {
    for (const entry of [...this.queue, ...this.running]) this.finish(entry, { ok: false, code: 'failed', message: 'disposed' }, 'disposed')
  }

  private start(entry: Entry<J, R>): void {
    this.running.add(entry)
    entry.timer = setTimeout(() => this.finish(entry, { ok: false, code: 'timeout' }, 'timeout'), this.deadlineMs)
    let task: Promise<R>
    try {
      task = this.runner(entry.job, entry.controller.signal)
    } catch (error) {
      task = Promise.reject(error)
    }
    task.then(
      (value) => this.finish(entry, { ok: true, value }),
      (error) => this.finish(entry, { ok: false, code: 'failed', message: error instanceof Error ? error.message : String(error) })
    )
  }

  private finish(entry: Entry<J, R>, outcome: ScheduledOutcome<R>, abortReason?: string): void {
    if (entry.settled) return
    entry.settled = true
    if (entry.timer) clearTimeout(entry.timer)
    if (this.byScope.get(entry.scope) === entry) this.byScope.delete(entry.scope)
    const queued = this.queue.indexOf(entry)
    if (queued >= 0) this.queue.splice(queued, 1)
    const wasRunning = this.running.delete(entry)
    if (abortReason && wasRunning) entry.controller.abort(abortReason)
    entry.settle(outcome)
    if (wasRunning) this.pump()
  }

  private pump(): void {
    while (this.running.size < this.concurrency && this.queue.length > 0) {
      const next = this.queue.shift()!
      this.start(next)
    }
  }
}
