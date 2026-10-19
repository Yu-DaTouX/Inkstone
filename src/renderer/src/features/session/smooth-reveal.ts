import { useEffect, useRef, useState } from 'react'
import { prefersReducedMotion } from '../../lib/reduced-motion'

export const REVEAL_SNAP_CHARS = 22
export const REVEAL_DRAIN_MS = 550
const REVEAL_FLOOR_CHARS = 150

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

export function nextRevealLength(text: string, shown: number, elapsedMs: number): number {
  const target = text.length
  if (shown >= target) return target
  const backlog = target - Math.max(0, shown)
  if (backlog <= REVEAL_SNAP_CHARS) return target
  const step = Math.max(1, Math.ceil((Math.max(backlog, REVEAL_FLOOR_CHARS) * Math.max(0, elapsedMs)) / REVEAL_DRAIN_MS))
  let next = Math.min(target, Math.max(0, shown) + step)
  if (next < target && isHighSurrogate(text.charCodeAt(next - 1))) next += 1
  return next
}


export function useSmoothReveal(text: string, live: boolean): string {
  const [shown, setShown] = useState(() => (live && !prefersReducedMotion() ? nextRevealLength(text, 0, 0) : text.length))
  const shownRef = useRef(shown)
  const textRef = useRef(text)
  textRef.current = text

  const animate = live && !prefersReducedMotion()
  const clamped = Math.min(shown, text.length)
  const pending = animate && clamped < text.length

  useEffect(() => {
    if (!pending) return undefined
    let raf = 0
    let last = performance.now()
    const tick = (now: number): void => {
      const current = textRef.current
      const next = nextRevealLength(current, Math.min(shownRef.current, current.length), now - last)
      last = now
      shownRef.current = next
      setShown(next)
      if (next < current.length) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [pending, text])

  if (!animate) {
    shownRef.current = text.length
    return text
  }
  shownRef.current = clamped
  return clamped >= text.length ? text : text.slice(0, clamped)
}
