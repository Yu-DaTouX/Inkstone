import { useLayoutEffect, useRef, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from '../../i18n'
import { dragPointer, useSplitDrag } from './split-drag'
import type { DropBadgeLabel } from './split-drop-model'
import { splitText, type SplitText } from './split-text'
import './split.css'

const GHOST_EDGE_PX = 20

function badgeText(label: DropBadgeLabel, text: SplitText): string {
  if (label === 'here') return text.openHere
  if (label === 'swap') return text.swap
  if (label === 'move') return text.moveHere
  return text.splitView
}

export function SplitDragLayer(): JSX.Element | null {
  const { lang } = useI18n()
  const text = splitText(lang)
  const badge = useSplitDrag((s) => s.badge)
  const dragging = useSplitDrag((s) => s.ghost !== null)
  if (!badge && !dragging) return null
  return (
    <>
      {badge ? (
        <div className="v3-split-drop" aria-hidden data-testid="v3-split-drop">
          <span
            className="v3-split-drop-badge"
            data-hint={badge.hint ? '' : undefined}
            data-label={badge.label}
            style={{ left: badge.box.left, top: badge.box.top, width: badge.box.width, height: badge.box.height }}
            data-testid="v3-split-drop-badge"
          >
            <span className="v3-split-drop-label">{badgeText(badge.label, text)}</span>
          </span>
        </div>
      ) : null}
      {dragging ? <DragGhostView fallback={text.dragLabel} /> : null}
    </>
  )
}

function DragGhostView({ fallback }: { fallback: string }): JSX.Element | null {
  const ghost = useSplitDrag((s) => s.ghost)
  const overTarget = useSplitDrag((s) => s.over)
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
  const over = overTarget || !clone
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
