/**
 * 停滞监测（v3 WP-10，方案 02 §4.5）。
 *
 * 每秒检查一次运行中的记录，按注入阈值把「无输出」的标记成 `stalled`。
 * **只标记，不中止** —— 停滞是更早的可见信号，绝不替用户停止任何东西。
 * 阈值默认 45s / 60s，设置里可在 30 秒–5 分钟之间调整（由 registry 夹取）。
 */
export interface StallMonitorOptions {
  /** 通常是 `registry.tick`；返回本次新标记的 runId */
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

  /** 单次检查（测试直接调用，不等真实定时器）。 */
  runOnce(): string[] {
    const now = (this.options.now ?? Date.now)()
    const stalled = this.options.tick(now)
    if (stalled.length > 0) this.options.onTick?.(stalled)
    return stalled
  }
}
