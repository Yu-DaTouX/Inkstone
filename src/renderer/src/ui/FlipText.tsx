import { useEffect, useLayoutEffect, useRef } from 'react'
import { prefersReducedMotion, subscribeReducedMotion } from '../lib/reduced-motion'
import './FlipText.css'

export function FlipText({ text, position }: { text: string; position: number }) {
  const labelRef = useRef<HTMLSpanElement>(null)
  const previousRef = useRef({ text, position })
  const animationsRef = useRef<Animation[]>([])
  const ghostRef = useRef<HTMLElement | null>(null)
  const stop = () => {
    for (const animation of animationsRef.current) animation.cancel()
    animationsRef.current = []
    ghostRef.current?.remove()
    ghostRef.current = null
  }

  useLayoutEffect(() => {
    const previous = previousRef.current
    previousRef.current = { text, position }
    const label = labelRef.current
    if (!label || previous.text === text) return
    stop()
    if (prefersReducedMotion()) return
    const direction = position >= previous.position ? 1 : -1
    const ghost = document.createElement('span')
    ghost.className = 'ui-flip-text__ghost'
    ghost.textContent = previous.text
    ghost.setAttribute('aria-hidden', 'true')
    label.parentElement?.appendChild(ghost)
    ghostRef.current = ghost
    const options = { duration: 180, easing: 'cubic-bezier(.22,1,.36,1)' }
    const outgoing = ghost.animate([
      { transform: 'translateY(0)', opacity: 1 },
      { transform: `translateY(${-direction * 100}%)`, opacity: 0 }
    ], { ...options, fill: 'forwards' })
    const incoming = label.animate([
      { transform: `translateY(${direction * 100}%)`, opacity: 0 },
      { transform: 'translateY(0)', opacity: 1 }
    ], options)
    animationsRef.current = [outgoing, incoming]
    const remove = () => {
      ghost.remove()
      if (ghostRef.current === ghost) ghostRef.current = null
    }
    outgoing.finished.then(remove, remove)
  }, [text, position])

  useEffect(() => {
    const unsubscribe = subscribeReducedMotion(() => { if (prefersReducedMotion()) stop() })
    return () => { unsubscribe(); stop() }
  }, [])

  return <span className="ui-flip-text"><span ref={labelRef}>{text}</span></span>
}
