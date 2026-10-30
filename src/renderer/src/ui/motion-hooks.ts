import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react'
import { prefersReducedMotion, subscribeReducedMotion } from '../lib/reduced-motion'
import { createMotionHold, parseDuration, presenceNext, type PresenceState } from './motion-model'

export type MotionDuration = 'fast' | 'snap' | 'quick' | 'lag' | 'base' | 'sheet' | 'slow' | 'stagger'

const FALLBACK_MS: Record<MotionDuration, number> = { fast: 60, snap: 120, quick: 150, lag: 50, base: 200, sheet: 300, slow: 450, stagger: 40 }

function hasDocumentRoot(): boolean {
  return typeof document !== 'undefined' && !!document.documentElement && typeof getComputedStyle === 'function'
}

export function motionMs(name: MotionDuration): number {
  if (!hasDocumentRoot()) return FALLBACK_MS[name]
  return parseDuration(getComputedStyle(document.documentElement).getPropertyValue(`--dur-${name}`), FALLBACK_MS[name])
}

const hold = createMotionHold({
  frame: (callback) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(callback) : (setTimeout(callback, 16) as unknown as number)),
  cancel: (id) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id))
})

hold.subscribe((held) => {
  if (!hasDocumentRoot()) return
  const root = document.documentElement
  if (held) root.dataset.motionHold = '1'
  else delete root.dataset.motionHold
})

export function holdMotion(): void {
  hold.hold()
}

export function motionHeld(): boolean {
  return hold.held()
}

export function motionAllowed(): boolean {
  if (!hasDocumentRoot()) return false
  return !prefersReducedMotion() && !hold.held()
}

function reducedSnapshot(): boolean {
  return hasDocumentRoot() && prefersReducedMotion()
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, reducedSnapshot, () => false)
}

export function useMotionHeld(): boolean {
  return useSyncExternalStore(
    (listener) => hold.subscribe(() => listener()),
    hold.held,
    () => false
  )
}

export function useHoldMotionOn(key: unknown): void {
  useLayoutEffect(() => {
    holdMotion()
  }, [key])
}

export function useNavigationHold(key: string): boolean {
  const [painted, setPainted] = useState<string | null>(null)
  const held = painted !== key
  useEffect(() => {
    if (!held) return
    let second = 0
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setPainted(key))
    })
    return () => {
      cancelAnimationFrame(first)
      cancelAnimationFrame(second)
    }
  }, [key, held])
  return held
}

export function useArrival(busy: boolean): boolean {
  const [seenBusy, setSeenBusy] = useState(busy)
  const [arrived, setArrived] = useState(false)
  if (seenBusy !== busy) {
    setSeenBusy(busy)
    setArrived(!busy && motionAllowed())
  }
  return arrived && !busy
}

export interface Presence {
  present: boolean
  closing: boolean
  entering: boolean
}

export function usePresence(open: boolean, { animate = true, exit = 'base' }: { animate?: boolean; exit?: MotionDuration } = {}): Presence {
  const reduced = useReducedMotion()
  const allowed = animate && !reduced
  const [state, setState] = useState<PresenceState>(open ? 'open' : 'closed')
  const [seenOpen, setSeenOpen] = useState(open)
  const [entering, setEntering] = useState(false)
  const next = presenceNext(state, open, allowed && !hold.held())
  if (next !== state) setState(next)
  if (seenOpen !== open) {
    setSeenOpen(open)
    setEntering(open && allowed && !hold.held())
  }
  useEffect(() => {
    if (state !== 'closing') return
    const timer = window.setTimeout(() => setState((current) => (current === 'closing' ? 'closed' : current)), motionMs(exit))
    return () => window.clearTimeout(timer)
  }, [state, exit])
  return { present: next !== 'closed', closing: next === 'closing', entering: open && entering }
}
