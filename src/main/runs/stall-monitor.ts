export interface StallMonitorOptions {
  tick: (now: number) => string[]
  intervalMs?: number
  now?: () => number
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
  onTick?: (stalled: string[]) => void
}

export class StallMonitor {
  private handle: unknown = null
  private readonly intervalMs: number
  private readonly schedule: (fn: () => void, ms: number) => unknown
  private readonly cancel: (handle: unknown) => void

  constructor(private readonly options: StallMonitorOptions) {
    this.intervalMs = options.intervalMs ?? 1000
    this.schedule = options.setInterval ?? ((fn, ms) => setInterval(fn, ms))
    this.cancel = options.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>))
  }

  get started(): boolean {
    return this.handle !== null
  }

  start(): void {
    if (this.handle !== null) return
    this.handle = this.schedule(() => this.runOnce(), this.intervalMs)
  }

  stop(): void {
    if (this.handle === null) return
    this.cancel(this.handle)
    this.handle = null
  }

  runOnce(): string[] {
    const now = (this.options.now ?? Date.now)()
    const stalled = this.options.tick(now)
    if (stalled.length > 0) this.options.onTick?.(stalled)
    return stalled
  }
}
