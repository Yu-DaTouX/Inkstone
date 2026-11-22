import { useEffect, useRef } from 'react'
import { motionAllowed, useReducedMotion } from './motion-hooks'
import './ScrambleText.css'

const SYMBOLS = '!@#$%&*+=?'
const DURATION_MS = 850
const FRAME_MS = 85
const START_DELAY_MS = 150

export function ScrambleText({ text }: { text: string }) {
  const visual = useRef<HTMLSpanElement>(null)
  const played = useRef<string | null>(null)
  const reduced = useReducedMotion()

  useEffect(() => {
    const node = visual.current
    if (!node || played.current === text) return undefined
    if (reduced) {
      played.current = text
      return undefined
    }
    const chars = Array.from(text, (char) => ({ char, scramble: /\p{L}/u.test(char) }))
    const letters = chars.filter(({ scramble }) => scramble).length
    let frame = 0
    let start: number | undefined
    let lastTick = -1
    const advance = (now: number): void => {
      played.current = text
      start ??= now
      const elapsed = now - start
      if (elapsed >= DURATION_MS) {
        node.textContent = text
        return
      }
      const tick = Math.floor(elapsed / FRAME_MS)
      if (tick !== lastTick) {
        lastTick = tick
        const resolved = Math.floor((tick * FRAME_MS / DURATION_MS) * letters)
        let index = 0
        node.textContent = chars.map(({ char, scramble }) => {
          if (!scramble || index++ < resolved) return char
          return SYMBOLS[(tick * 7 + index * 11) % SYMBOLS.length]
        }).join('')
      }
      frame = requestAnimationFrame(advance)
    }
    const timer = window.setTimeout(() => {
      if (motionAllowed()) frame = requestAnimationFrame(advance)
    }, START_DELAY_MS)
    return () => {
      window.clearTimeout(timer)
      cancelAnimationFrame(frame)
      node.textContent = text
    }
  }, [reduced, text])

  return (
    <span className="ui-scramble">
      <span className="sr-only">{text}</span>
      <span className="ui-scramble__measure" aria-hidden="true">{text}</span>
      <span key={text} ref={visual} className="ui-scramble__visual" aria-hidden="true">{text}</span>
    </span>
  )
}
