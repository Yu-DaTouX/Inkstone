export interface FrameBatch<T> {
  schedule: (value: T) => void
  flush: () => void
  cancel: () => void
}

export function createFrameBatch<T>(
  apply: (value: T) => void,
  request: (callback: FrameRequestCallback) => number = requestAnimationFrame,
  cancel: (frame: number) => void = cancelAnimationFrame
): FrameBatch<T> {
  let frame: number | null = null
  let pending: { value: T } | null = null
  const clearFrame = (): void => {
    if (frame !== null) cancel(frame)
    frame = null
  }
  const flush = (): void => {
    clearFrame()
    const next = pending
    pending = null
    if (next) apply(next.value)
  }
  return {
    schedule: (value) => {
      pending = { value }
      if (frame === null) frame = request(flush)
    },
    flush,
    cancel: () => {
      clearFrame()
      pending = null
    }
  }
}
