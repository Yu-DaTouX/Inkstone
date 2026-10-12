export interface TimerScheduler {
  set(callback: () => void, delay: number): unknown
  clear(handle: unknown): void
}

export function createPerIdTimers(scheduler: TimerScheduler) {
  const timers = new Map<string, unknown>()
  return {
    has(id: string): boolean {
      return timers.has(id)
    },
    schedule(id: string, delay: number, callback: () => void): void {
      const previous = timers.get(id)
      if (previous !== undefined) scheduler.clear(previous)
      const handle = scheduler.set(() => {
        timers.delete(id)
        callback()
      }, delay)
      timers.set(id, handle)
    },
    clearMissing(ids: ReadonlySet<string>): void {
      for (const [id, handle] of timers) {
        if (ids.has(id)) continue
        scheduler.clear(handle)
        timers.delete(id)
      }
    },
    dispose(): void {
      for (const handle of timers.values()) scheduler.clear(handle)
      timers.clear()
    }
  }
}

export function optionKey(value: string, index: number): string {
  return `${value}:${index}`
}
