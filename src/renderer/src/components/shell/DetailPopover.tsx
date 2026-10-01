import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../../state/store'

/**
 * A compact trigger with a details panel that opens upward from it (composer and status bar
 * sit at the bottom). While open it holds an overlay token so the native browser cannot cover it.
 */
export function DetailTrigger({ label, className, testId, title, children, panel }: {
  label: string
  className?: string
  testId?: string
  title?: string
  /** The always-visible summary inside the trigger. */
  children: ReactNode
  /** Panel content, rendered only while open. */
  panel: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [at, setAt] = useState<{ bottom: number; left?: number; right?: number }>({ bottom: 0 })
  const trigger = useRef<HTMLButtonElement>(null)
  const pop = useRef<HTMLElement>(null)
  const acquire = useStore(s => s.acquireOverlayBlocker)
  useLayoutEffect(() => {
    if (!open || !trigger.current) return
    const r = trigger.current.getBoundingClientRect()
    const bottom = window.innerHeight - r.top + 6
    /* Keep the panel inside the window: align to whichever side of the trigger has room. */
    setAt(r.left + 320 > window.innerWidth ? { bottom, right: Math.max(8, window.innerWidth - r.right) } : { bottom, left: Math.max(8, r.left) })
  }, [open])
  useEffect(() => {
    if (!open) return
    const release = acquire('detail-popover')
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); trigger.current?.focus() } }
    const down = (e: PointerEvent) => {
      const target = e.target as Node
      if (!pop.current?.contains(target) && !trigger.current?.contains(target)) setOpen(false)
    }
    document.addEventListener('keydown', key)
    document.addEventListener('pointerdown', down)
    return () => { release(); document.removeEventListener('keydown', key); document.removeEventListener('pointerdown', down) }
  }, [open, acquire])
  return <>
    <button ref={trigger} type="button" className={className} title={title} aria-label={label} aria-expanded={open} aria-haspopup="dialog" data-testid={testId} onClick={() => setOpen(v => !v)}>
      {children}
    </button>
    {open ? createPortal(
      <section ref={pop} className="ui-detail-popover detail-trigger-pop" role="dialog" aria-label={label} style={at}>
        {panel}
      </section>, document.body) : null}
  </>
}
