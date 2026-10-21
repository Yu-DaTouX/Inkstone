import { useEffect, useState, type JSX } from 'react'
import { prefersReducedMotion, subscribeReducedMotion } from '../../lib/reduced-motion'

const BLINK_HALF_PERIOD_MS = 600

function nextBlinkVisible(visible: boolean, running: boolean): boolean {
  return running ? !visible : true
}

export function BlinkCursor({ className }: { className?: string }): JSX.Element {
  const [visible, setVisible] = useState(true)
  useEffect(() => {
    let timer = 0
    const running = (): boolean => document.visibilityState !== 'hidden' && !prefersReducedMotion()
    const sync = (): void => {
      window.clearInterval(timer)
      timer = 0
      setVisible(true)
      if (running()) timer = window.setInterval(() => setVisible((value) => nextBlinkVisible(value, running())), BLINK_HALF_PERIOD_MS)
    }
    sync()
    document.addEventListener('visibilitychange', sync)
    const unsubscribe = subscribeReducedMotion(sync)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', sync)
      unsubscribe()
    }
  }, [])
  return (
    <span className={className} data-blink={visible ? 'on' : 'off'} aria-hidden>
      _
    </span>
  )
}
