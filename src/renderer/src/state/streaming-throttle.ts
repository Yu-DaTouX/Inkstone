import { useEffect, useRef, useState } from 'react'
import { useStore, type Store } from './store'

const STREAMING_INTERVAL_MS = 250

function streamingNow(s: Store): boolean {
  return !!s.session?.isStreaming || !!s.session?.isAgentRunning
}

export function useThrottledValue<T>(value: T, active: boolean, intervalMs = STREAMING_INTERVAL_MS): T {
  const [shown, setShown] = useState(value)
  const lastAt = useRef(0)
  useEffect(() => {
    if (Object.is(value, shown)) return undefined
    const wait = active ? Math.max(0, intervalMs - (performance.now() - lastAt.current)) : 0
    const timer = setTimeout(() => {
      lastAt.current = performance.now()
      setShown(() => value)
    }, wait)
    return () => clearTimeout(timer)
  }, [value, shown, active, intervalMs])
  return active ? shown : value
}

export function useStreamingThrottledStore<T>(
  selector: (s: Store) => T,
  intervalMs = STREAMING_INTERVAL_MS,
  equals: (a: T, b: T) => boolean = Object.is
): T {
  const selectorRef = useRef(selector)
  selectorRef.current = selector
  const equalsRef = useRef(equals)
  equalsRef.current = equals
  const [value, setValue] = useState(() => selector(useStore.getState()))
  const valueRef = useRef(value)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let lastAt = 0
    const publish = (): void => {
      timer = null
      lastAt = performance.now()
      const next = selectorRef.current(useStore.getState())
      if (equalsRef.current(next, valueRef.current)) return
      valueRef.current = next
      setValue(() => next)
    }
    publish()
    const unsubscribe = useStore.subscribe((s) => {
      if (equalsRef.current(selectorRef.current(s), valueRef.current)) return
      if (!streamingNow(s)) {
        if (timer) clearTimeout(timer)
        publish()
        return
      }
      if (timer) return
      timer = setTimeout(publish, Math.max(0, intervalMs - (performance.now() - lastAt)))
    })
    return () => {
      unsubscribe()
      if (timer) clearTimeout(timer)
    }
  }, [intervalMs])

  return value
}
