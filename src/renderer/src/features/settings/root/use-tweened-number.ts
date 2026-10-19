import { useLayoutEffect, useRef, useState } from 'react'
import { prefersReducedMotion } from '../../../lib/reduced-motion'

const TWEEN_MS = 420

export function useTweenedNumber(target: number): number {
  const [shown, setShown] = useState(target)
  const shownRef = useRef<number | null>(null)

  useLayoutEffect(() => {
    const from = shownRef.current ?? 0
    if (from === target || prefersReducedMotion()) {
      shownRef.current = target
      setShown(target)
      return
    }
    shownRef.current = from
    setShown(from)
    const start = performance.now()
    let frame = 0
    const step = (now: number): void => {
      const t = Math.min(1, (now - start) / TWEEN_MS)
      const eased = 1 - Math.pow(1 - t, 3)
      const value = from + (target - from) * eased
      shownRef.current = value
      setShown(value)
      if (t < 1) frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [target])

  return shown
}
