import { useEffect, useMemo, useRef } from 'react'

export interface HoverDelay {
  start: () => void
  cancel: () => void
}

export function useHoverDelay(ms: number, action: () => void): HoverDelay {
  const timer = useRef<number | null>(null)
  const latest = useRef(action)
  latest.current = action
  const delay = useMemo<HoverDelay>(() => {
    const cancel = (): void => {
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = null
    }
    return {
      cancel,
      start: () => {
        cancel()
        timer.current = window.setTimeout(() => { timer.current = null; latest.current() }, ms)
      }
    }
  }, [ms])
  useEffect(() => delay.cancel, [delay])
  return delay
}
