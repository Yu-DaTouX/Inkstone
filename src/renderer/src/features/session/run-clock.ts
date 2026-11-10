import { useEffect, useLayoutEffect, useState } from 'react'

type Listener = () => void

const listeners = new Set<Listener>()
let current = 0
let timer: ReturnType<typeof setInterval> | null = null

const useClockEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

function tick(): void {
  current = Date.now()
  for (const listener of [...listeners]) listener()
}

export function subscribeRunNow(listener: Listener): () => void {
  listeners.add(listener)
  const now = Date.now()
  if (now > current) current = now
  if (timer === null) timer = globalThis.setInterval(tick, 1000)
  return () => {
    listeners.delete(listener)
    if (listeners.size > 0 || timer === null) return
    globalThis.clearInterval(timer)
    timer = null
    current = 0
  }
}

export function runNow(): number {
  if (current === 0) current = Date.now()
  return current
}

export function elapsedSince(startedAt: number | null | undefined, now: number): number | null {
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt) || startedAt <= 0) return null
  return Math.max(0, now - startedAt)
}

export function useRunNow(active: boolean): number {
  const [now, setNow] = useState(runNow)
  useClockEffect(() => {
    if (!active) return undefined
    const off = subscribeRunNow(() => setNow(runNow()))
    setNow(runNow())
    return off
  }, [active])
  return now
}
