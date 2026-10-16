export interface OverlayBlockerLifecycleDeps {
  hasOverlay: () => boolean
  acquire: () => () => void
  requestFrame?: (callback: () => void) => number
  cancelFrame?: (handle: number) => void
}

export interface OverlayBlockerLifecycle {
  schedule: () => void
  evaluate: () => void
  dispose: () => void
  holding: () => boolean
}

export function createOverlayBlockerLifecycle(deps: OverlayBlockerLifecycleDeps): OverlayBlockerLifecycle {
  const requestFrame = deps.requestFrame ?? ((callback) => requestAnimationFrame(callback))
  const cancelFrame = deps.cancelFrame ?? ((handle) => cancelAnimationFrame(handle))

  let disposed = false
  let release: (() => void) | null = null
  let frame: number | null = null

  const evaluate = (): void => {
    frame = null
    if (disposed) return
    const present = deps.hasOverlay()
    if (present && !release) {
      release = deps.acquire()
    } else if (!present && release) {
      const releaseNow = release
      release = null
      releaseNow()
    }
  }

  const schedule = (): void => {
    if (disposed || frame !== null) return
    frame = requestFrame(evaluate)
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    if (frame !== null) {
      cancelFrame(frame)
      frame = null
    }
    const releaseNow = release
    release = null
    releaseNow?.()
  }

  return {
    schedule,
    evaluate,
    dispose,
    holding: () => release !== null
  }
}
