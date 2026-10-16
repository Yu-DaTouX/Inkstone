import type { TrayAnimationState, TrayFrameSet, TrayTheme } from './tray-assets'

export type { TrayAnimationState, TrayFrameSet, TrayTheme } from './tray-assets'

export interface TrayAnimationClock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface TrayAnimationPorts {
  assets(state: TrayAnimationState, theme: TrayTheme): TrayFrameSet | undefined
  theme(): TrayTheme
  apply(image: unknown): void
  clock?: TrayAnimationClock
  onError?(error: unknown): void
}

export interface TrayAnimationPlayer {
  setState(state: TrayAnimationState): void
  setMotionAllowed(allowed: boolean): void
  refresh(): void
  state(): TrayAnimationState
  frameIndex(): number
  animating(): boolean
  dispose(): void
}

const REAL_CLOCK: TrayAnimationClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

function usable(set: TrayFrameSet | undefined): set is TrayFrameSet {
  if (!set || !Array.isArray(set.frames) || set.frames.length === 0) return false
  return set.frames.every((frame) => frame && typeof frame.durationMs === 'number' && frame.durationMs > 0)
}

export function createTrayAnimationPlayer(ports: TrayAnimationPorts): TrayAnimationPlayer {
  const clock = ports.clock ?? REAL_CLOCK
  let state: TrayAnimationState = 'idle'
  let motionAllowed = false
  let disposed = false
  let timer: unknown = null
  let frames: TrayFrameSet['frames'] | null = null
  let staticImage: unknown = undefined
  let index = 0
  let startAt = 0
  let period = 0
  let applied = -1

  const report = (error: unknown): void => {
    try {
      ports.onError?.(error)
    } catch {
    }
  }

  const clearTimer = (): void => {
    if (timer !== null) {
      clock.clearTimeout(timer)
      timer = null
    }
  }

  const resolve = (): TrayFrameSet | undefined => {
    try {
      const direct = ports.assets(state, ports.theme())
      if (usable(direct)) return direct
      if (state !== 'idle') {
        const idle = ports.assets('idle', ports.theme())
        if (usable(idle)) return idle
      }
      return undefined
    } catch (error) {
      report(error)
      return undefined
    }
  }

  const applyImage = (image: unknown): void => {
    if (image === undefined || image === null) return
    try {
      ports.apply(image)
    } catch (error) {
      report(error)
    }
  }

  const showStatic = (): void => {
    clearTimer()
    applied = -1
    index = 0
    const set = resolve()
    frames = set ? set.frames : null
    staticImage = set ? (set.static ?? set.frames[0]?.image) : undefined
    applyImage(staticImage)
  }

  const schedule = (): void => {
    if (disposed || !frames || frames.length < 2) return
    clearTimer()
    const elapsed = clock.now() - startAt
    const pos = period > 0 ? ((elapsed % period) + period) % period : 0
    let acc = 0
    let next = frames.length - 1
    for (let i = 0; i < frames.length; i += 1) {
      if (pos < acc + frames[i].durationMs) {
        next = i
        break
      }
      acc += frames[i].durationMs
    }
    if (next !== applied) {
      index = next
      applied = next
      applyImage(frames[next].image)
    }
    const wait = Math.max(1, acc + frames[next].durationMs - pos)
    timer = clock.setTimeout(() => {
      timer = null
      schedule()
    }, wait)
  }

  const startAnimation = (): void => {
    clearTimer()
    applied = -1
    const set = resolve()
    if (!usable(set) || set.frames.length < 2) {
      showStatic()
      return
    }
    frames = set.frames
    staticImage = set.static ?? set.frames[0]?.image
    period = set.frames.reduce((acc, frame) => acc + frame.durationMs, 0)
    startAt = clock.now()
    index = 0
    applied = 0
    applyImage(set.frames[0].image)
    schedule()
  }

  const restart = (): void => {
    if (disposed) return
    if (!motionAllowed || state === 'idle') showStatic()
    else startAnimation()
  }

  return {
    setState(next) {
      if (disposed || next === state) return
      state = next
      restart()
    },
    setMotionAllowed(allowed) {
      if (disposed || allowed === motionAllowed) return
      motionAllowed = allowed
      restart()
    },
    refresh() {
      restart()
    },
    state: () => state,
    frameIndex: () => index,
    animating: () => timer !== null,
    dispose() {
      disposed = true
      clearTimer()
      frames = null
      staticImage = undefined
    }
  }
}
