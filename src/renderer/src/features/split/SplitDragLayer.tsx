import { useLayoutEffect, useRef, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from '../../i18n'
import { dragPointer, useSplitDrag } from './split-drag'
import { splitText } from './split-text'
import './split.css'

export function SplitDragLayer(): JSX.Element | null {
  const { lang } = useI18n()
  const text = splitText(lang)
  const item = useSplitDrag((s) => s.item)
  const badge = useSplitDrag((s) => s.badge)
  if (!item) return null
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
            <span className="v3-split-drop-label">{badge.label === 'here' ? text.openHere : text.splitView}</span>
          </span>
        </div>
      ) : null}
      <SessionDragGhost label={text.dragLabel} />
    </>
  )
}

function SessionDragGhost({ label }: { label: string }): JSX.Element | null {
  const ghost = useSplitDrag((s) => s.ghost)
  const over = useSplitDrag((s) => s.target !== null)
  const outer = useRef<HTMLDivElement>(null)
  const cloneHost = useRef<HTMLDivElement>(null)
  const measure = useRef<HTMLSpanElement>(null)
  const [labelWidth, setLabelWidth] = useState<number | null>(null)

  useLayoutEffect(() => {
    if (measure.current) setLabelWidth(Math.ceil(measure.current.offsetWidth))
  }, [label, ghost])

  useLayoutEffect(() => {
    const node = outer.current
    if (!ghost || !node) return undefined
    let frame = 0
    const follow = (): void => {
      node.style.transform = `translate(${dragPointer.x}px, ${dragPointer.y}px)`
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
  const narrow = over && labelWidth !== null
  const width = narrow ? Math.min(labelWidth ?? ghost.width, ghost.width) : ghost.width
  const left = narrow ? Math.round(width / 2) : ghost.dx
  const top = narrow ? Math.round(ghost.height / 2) : ghost.dy
  return createPortal(
    <div ref={outer} className="v3-session-ghost" aria-hidden data-testid="v3-session-ghost" data-over={over ? '' : undefined}>
      <div
        className="v3-session-ghost-row"
        style={{ left: -left, top: -top, width, height: ghost.height, transformOrigin: `${left}px ${top}px` }}
      >
        <div ref={cloneHost} className="v3-session-ghost-clone" />
        <div className="v3-session-ghost-label">
          <span>{label}</span>
        </div>
        <span ref={measure} className="v3-session-ghost-measure">{label}</span>
      </div>
    </div>,
    document.body
  )
}
