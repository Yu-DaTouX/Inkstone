import { useEffect, useState } from 'react'

export function useAppearDelay(ids: readonly string[], waiting: boolean, delayMs: number): (id: string) => boolean {
  const [ready, setReady] = useState<ReadonlySet<string>>(new Set())
  const key = ids.join('|')
  useEffect(() => {
    if (!waiting) {
      setReady(new Set(ids))
      return undefined
    }
    if (ids.every((id) => ready.has(id))) return undefined
    const timer = window.setTimeout(() => setReady((current) => new Set([...current, ...ids])), delayMs)
    return () => window.clearTimeout(timer)
  }, [key, waiting, delayMs])
  return (id) => !waiting || ready.has(id)
}
