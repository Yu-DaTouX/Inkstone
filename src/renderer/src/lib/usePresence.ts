import { useEffect, useRef, useState } from 'react'

export function usePresence(open: boolean, ms: number): { mounted: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(open)
  const [closing, setClosing] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }

    if (open) {
      setMounted(true)
      setClosing(false)
      return
    }

    if (!mounted) return
    setClosing(true)
    timer.current = setTimeout(() => {
      timer.current = null
      setClosing(false)
      setMounted(false)
    }, ms)
  }, [open, ms, mounted])

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  return { mounted, closing }
}

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false
  } catch {
    return false
  }
}
