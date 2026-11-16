export interface IdleTimers {
  set(run: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export interface IdleTaskOptions {
  name: string
  firstDelayMs: number
  intervalMs: number
  retryMs: number
  backoffMs?: readonly number[]
  isBusy: () => boolean
  run: () => Promise<boolean | 'busy' | void>
  log?: (line: string) => void
  timers?: IdleTimers
}

const defaultTimers: IdleTimers = {
  set(run, ms) {
    const handle = setTimeout(run, ms)
    handle.unref?.()
    return handle
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  }
}

export function scheduleIdleTask(options: IdleTaskOptions): () => void {
  const timers = options.timers ?? defaultTimers
  const log = options.log ?? ((line: string) => console.warn(line))
  let handle: unknown
  let stopped = false
  let misses = 0
  const arm = (ms: number): void => {
    if (!stopped) handle = timers.set(() => void tick(), ms)
  }
  const tick = async (): Promise<void> => {
    if (stopped) return
    let busy = true
    try {
      busy = options.isBusy()
    } catch {
    }
    if (busy) {
      arm(options.retryMs)
      return
    }
    let next = options.intervalMs
    try {
      const outcome = await options.run()
      if (outcome === 'busy') next = options.retryMs
      else if (outcome === false) {
        const steps = options.backoffMs?.length ? options.backoffMs : [options.retryMs]
        next = steps[Math.min(misses, steps.length - 1)]
        misses += 1
      } else misses = 0
    } catch (error) {
      misses = 0
      log(`[maintenance] ${options.name} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    arm(next)
  }
  arm(options.firstDelayMs)
  return () => {
    stopped = true
    timers.clear(handle)
  }
}
