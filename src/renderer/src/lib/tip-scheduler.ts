export const TIP_FIRST_DELAY_MS = 400
export const TIP_WARM_DELAY_MS = 0
export const TIP_WARM_WINDOW_MS = 600

export interface TipTimerHost {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  now(): number
}

const defaultHost: TipTimerHost = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now()
}

export class TipScheduler {
  private visibleId: symbol | null = null
  private visibleHide: (() => void) | null = null
  private pendingId: symbol | null = null
  private pendingTimer: unknown = null
  private warmUntil = 0

  constructor(private readonly host: TipTimerHost = defaultHost) {}

  request(id: symbol, show: () => void, hide: () => void, immediate = false): number {
    if (this.visibleId === id) {
      this.visibleHide = hide
      return 0
    }
    this.clearPendingTimer()
    const warm = this.visibleId !== null || this.host.now() < this.warmUntil
    const delay = immediate ? 0 : warm ? TIP_WARM_DELAY_MS : TIP_FIRST_DELAY_MS
    if (delay <= 0) {
      this.show(id, show, hide)
      return 0
    }
    this.pendingId = id
    this.pendingTimer = this.host.setTimeout(() => {
      this.pendingTimer = null
      this.pendingId = null
      this.show(id, show, hide)
    }, delay)
    return delay
  }

  cancel(id: symbol): void {
    if (this.pendingId === id) this.clearPendingTimer()
  }

  release(id: symbol): void {
    if (this.pendingId === id) this.clearPendingTimer()
    if (this.visibleId === id) {
      this.visibleId = null
      this.visibleHide = null
      this.markWarm()
    }
  }

  dismiss(): boolean {
    if (this.visibleId === null) return false
    this.hideVisible()
    this.markWarm()
    return true
  }

  isVisible(id: symbol): boolean {
    return this.visibleId === id
  }

  get hasPending(): boolean {
    return this.pendingId !== null
  }

  reset(): void {
    this.clearPendingTimer()
    this.visibleId = null
    this.visibleHide = null
    this.warmUntil = 0
  }

  private show(id: symbol, show: () => void, hide: () => void): void {
    if (this.visibleId !== null && this.visibleId !== id) this.hideVisible()
    this.visibleId = id
    this.visibleHide = hide
    this.markWarm()
    show()
  }

  private hideVisible(): void {
    const hide = this.visibleHide
    this.visibleId = null
    this.visibleHide = null
    hide?.()
  }

  private markWarm(): void {
    this.warmUntil = this.host.now() + TIP_WARM_WINDOW_MS
  }

  private clearPendingTimer(): void {
    if (this.pendingTimer !== null) this.host.clearTimeout(this.pendingTimer)
    this.pendingTimer = null
    this.pendingId = null
  }
}

export const tipScheduler = new TipScheduler()

export function isTipActive(input: { hover: boolean; focused: boolean }): boolean {
  return input.hover || input.focused
}
