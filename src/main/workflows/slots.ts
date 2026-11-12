export type SlotRelease = () => void

interface Waiter {
  resolve(release: SlotRelease | null): void
  signal?: AbortSignal
}

export interface SlotGateOptions {
  capacity: number
  running(): number
  pollMs?: number
}

export class SlotGate {
  private reserved = 0
  private readonly waiters: Waiter[] = []
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly opts: SlotGateOptions) {}

  get waiting(): number {
    return this.waiters.length
  }

  get held(): number {
    return this.reserved
  }

  available(): number {
    let running = 0
    try {
      running = this.opts.running()
    } catch {
      running = this.opts.capacity
    }
    return this.opts.capacity - running - this.reserved
  }

  acquire(signal?: AbortSignal): Promise<SlotRelease | null> {
    if (signal?.aborted) return Promise.resolve(null)
    return new Promise((resolve) => {
      const waiter: Waiter = { resolve, signal }
      this.waiters.push(waiter)
      signal?.addEventListener('abort', () => this.notify(), { once: true })
      this.notify()
    })
  }

  notify(): void {
    for (let i = 0; i < this.waiters.length;) {
      if (this.waiters[i].signal?.aborted) {
        const [dropped] = this.waiters.splice(i, 1)
        dropped.resolve(null)
      } else i += 1
    }
    while (this.waiters.length && this.available() > 0) {
      const waiter = this.waiters.shift()!
      this.reserved += 1
      let released = false
      waiter.resolve(() => {
        if (released) return
        released = true
        this.reserved -= 1
        this.notify()
      })
    }
    this.arm()
  }

  private arm(): void {
    if (this.timer || !this.waiters.length) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.notify()
    }, this.opts.pollMs ?? 1000)
    if (typeof this.timer === 'object' && this.timer && 'unref' in this.timer) this.timer.unref()
  }
}
