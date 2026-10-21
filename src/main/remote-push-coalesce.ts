import type { MainPush } from '../shared/ipc'

export const REMOTE_COALESCE_CHANNELS = new Set(['queue', 'runners', 'stats'])
export const REMOTE_COALESCE_INTERVAL_MS = 250

type Schedule = (run: () => void, ms: number) => () => void

const defaultSchedule: Schedule = (run, ms) => {
  const timer = setTimeout(run, ms)
  timer.unref?.()
  return () => clearTimeout(timer)
}

export class RemotePushCoalescer {
  private pending = new Map<string, MainPush>()
  private cancel: (() => void) | null = null

  constructor(
    private readonly emit: (message: MainPush) => void,
    private readonly intervalMs: number = REMOTE_COALESCE_INTERVAL_MS,
    private readonly schedule: Schedule = defaultSchedule
  ) {}

  push(message: MainPush): void {
    if (!REMOTE_COALESCE_CHANNELS.has(message.ch)) {
      this.flush()
      this.emit(message)
      return
    }
    this.pending.set(message.ch, message)
    if (this.cancel) return
    this.cancel = this.schedule(() => {
      this.cancel = null
      this.flush()
    }, this.intervalMs)
  }

  flush(): void {
    this.cancel?.()
    this.cancel = null
    if (this.pending.size === 0) return
    const queued = [...this.pending.values()]
    this.pending.clear()
    for (const message of queued) this.emit(message)
  }

  dispose(): void {
    this.cancel?.()
    this.cancel = null
    this.pending.clear()
  }
}
