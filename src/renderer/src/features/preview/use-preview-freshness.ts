import { useEffect, useRef } from 'react'

export interface PreviewFreshnessTarget {
  abs: string
  cwd: string
  mtimeMs?: number
  size?: number
}

export function usePreviewFreshness(
  enabled: boolean,
  target: PreviewFreshnessTarget | null,
  onStale: () => void,
  intervalMs = 10_000
): void {
  const targetRef = useRef(target)
  targetRef.current = target
  const onStaleRef = useRef(onStale)
  onStaleRef.current = onStale

  const abs = target?.abs
  const cwd = target?.cwd
  const mtimeMs = target?.mtimeMs
  const size = target?.size

  useEffect(() => {
    if (!enabled || !abs) return undefined
    let cancelled = false
    let checking = false
    const check = async (): Promise<void> => {
      const current = targetRef.current
      if (!current || current.abs !== abs) return
      if (current.mtimeMs === undefined && current.size === undefined) return
      if (checking) return
      checking = true
      try {
        const result = await window.yan.statPreview(current.abs, current.cwd)
        if (cancelled || !result.ok) return
        if (result.mtimeMs !== undefined && current.mtimeMs !== undefined && result.mtimeMs !== current.mtimeMs) {
          onStaleRef.current()
          return
        }
        if (result.size !== undefined && current.size !== undefined && result.size !== current.size) {
          onStaleRef.current()
        }
      } finally {
        checking = false
      }
    }
    const onFocus = (): void => {
      void check()
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') void check()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    const timer = window.setInterval(() => {
      void check()
    }, intervalMs)
    return () => {
      cancelled = true
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
      window.clearInterval(timer)
    }
  }, [enabled, abs, cwd, mtimeMs, size, intervalMs])
}
