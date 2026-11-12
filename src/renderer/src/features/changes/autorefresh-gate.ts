export const ACTIVITY_DEBOUNCE_MS = 1_500
export const RUNNING_MIN_GAP_MS = 5_000
export const IDLE_ACTIVITY_DELAY_MS = 400
export const TURN_END_DELAY_MS = 300
export const FOCUS_MIN_GAP_MS = 2_000

export interface AutoRefreshGateDeps<T> {
  fire: () => void
  canFire: () => boolean
  now: () => number
  setTimer: (fn: () => void, ms: number) => T
  clearTimer: (id: T) => void
}

export interface AutoRefreshGate {
  activity: (running: boolean) => void
  turnEnded: () => void
  focused: () => void
  shown: () => void
  dispose: () => void
}

export function createAutoRefreshGate<T>(deps: AutoRefreshGateDeps<T>): AutoRefreshGate {
  let timer: T | null = null
  let dirty = false
  let lastFireAt = deps.now()

  const cancel = (): void => {
    if (timer === null) return
    deps.clearTimer(timer)
    timer = null
  }

  const run = (): void => {
    timer = null
    if (!deps.canFire()) {
      dirty = true
      return
    }
    dirty = false
    lastFireAt = deps.now()
    deps.fire()
  }

  const schedule = (ms: number, replace: boolean): void => {
    if (timer !== null && !replace) return
    cancel()
    timer = deps.setTimer(run, Math.max(0, ms))
  }

  return {
    activity(running) {
      if (!deps.canFire()) {
        dirty = true
        return
      }
      if (running) {
        const gap = lastFireAt + RUNNING_MIN_GAP_MS - deps.now()
        schedule(Math.max(ACTIVITY_DEBOUNCE_MS, gap), false)
        return
      }
      schedule(IDLE_ACTIVITY_DELAY_MS, true)
    },
    turnEnded() {
      if (!deps.canFire()) {
        dirty = true
        return
      }
      schedule(TURN_END_DELAY_MS, true)
    },
    focused() {
      if (!deps.canFire()) return
      if (dirty || deps.now() - lastFireAt >= FOCUS_MIN_GAP_MS) schedule(0, true)
    },
    shown() {
      if (!deps.canFire()) return
      if (dirty || deps.now() - lastFireAt >= FOCUS_MIN_GAP_MS) schedule(0, true)
    },
    dispose() {
      cancel()
    }
  }
}
