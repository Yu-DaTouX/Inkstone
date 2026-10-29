import { useLayoutEffect, useRef, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { dragPointer, useSessionDrag } from './session-drag'
import './session-drag.css'

const GHOST_EDGE_PX = 20

export function SessionDragLayer(): JSX.Element | null {
  const dragging = useSessionDrag((s) => s.ghost !== null)
  return dragging ? <DragGhostView fallback="" /> : null
}

function DragGhostView({ fallback }: { fallback: string }): JSX.Element | null {
  const ghost = useSessionDrag((s) => s.ghost)
  const outer = useRef<HTMLDivElement>(null)
  const cloneHost = useRef<HTMLDivElement>(null)
  const measure = useRef<HTMLSpanElement>(null)
  const [labelWidth, setLabelWidth] = useState<number | null>(null)
  const label = ghost?.label || fallback

  useLayoutEffect(() => {
    if (measure.current) setLabelWidth(Math.ceil(measure.current.offsetWidth))
  }, [label, ghost])

  useLayoutEffect(() => {
    const node = outer.current
    if (!ghost || !node) return undefined
    let frame = 0
    const follow = (): void => {
      const y = Math.max(GHOST_EDGE_PX, Math.min(dragPointer.y, window.innerHeight - GHOST_EDGE_PX))
      node.style.transform = `translate(${dragPointer.x}px, ${y}px)`
      frame = requestAnimationFrame(follow)
    }
    follow()
    return () => cancelAnimationFrame(frame)
  }, [ghost])

  const clone = ghost?.clone ?? null
  useLayoutEffect(() => {
    const host = cloneHost.current
    if (!host || !clone) return undefined
    host.appendChild(clone)
    return () => clone.remove()
  }, [clone])

  if (!ghost) return null
  const over = !clone
  const narrow = over && labelWidth !== null
  const width = narrow ? Math.min(labelWidth ?? ghost.width, ghost.width) : ghost.width
  const left = narrow ? Math.round(width / 2) : ghost.dx
  const top = narrow ? Math.round(ghost.height / 2) : ghost.dy
  return createPortal(
    <div
      ref={outer}
      className="v3-session-ghost"
      aria-hidden
      data-testid="v3-session-ghost"
      data-over={over ? '' : undefined}
      data-kind={clone ? 'row' : 'label'}
    >
      <div
        className="v3-session-ghost-row"
        style={{ left: -left, top: -top, width, height: ghost.height, transformOrigin: `${left}px ${top}px` }}
      >
        {clone ? <div ref={cloneHost} className="v3-session-ghost-clone" /> : null}
        <div className="v3-session-ghost-label">
          <span>{label}</span>
        </div>
        <span ref={measure} className="v3-session-ghost-measure">{label}</span>
      </div>
    </div>,
    document.body
  )
}
