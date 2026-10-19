import { useRef, type KeyboardEvent, type PointerEvent, type ReactElement, type ReactNode } from 'react'
import { ArrowUpRight, ChevronDown, ChevronRight, GripVertical } from 'lucide-react'
import { Button, IconButton } from '../../ui'
import type { RailSectionId } from './rail-sections'

export interface RailGrip {
  label: string
  picked: boolean
  onPointerDown: (event: PointerEvent<HTMLElement>) => void
  onPress: () => void
  onKeyDown: (event: KeyboardEvent) => void
  onBlur: () => void
}

export interface RailCardProps {
  id: RailSectionId
  title: string
  summary?: ReactNode
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpenView?: () => void
  openLabel?: string
  tone?: 'ok' | 'ask' | 'fail'
  grip: RailGrip
  dragging: boolean
  onHeaderMenu: (anchor: HTMLElement) => void
  children?: ReactNode
}

export function RailCard({
  id,
  title,
  summary,
  open,
  onOpenChange,
  onOpenView,
  openLabel,
  tone,
  grip,
  dragging,
  onHeaderMenu,
  children
}: RailCardProps): ReactElement {
  const headRef = useRef<HTMLDivElement>(null)
  const openMenu = (): void => {
    if (headRef.current) onHeaderMenu(headRef.current)
  }
  return (
    <section
      className="wb-tile"
      data-rail-section={id}
      data-tile={id}
      data-folded={open ? '0' : '1'}
      data-tone={tone}
      data-dragging={dragging ? '1' : undefined}
      data-picked={grip.picked ? '1' : undefined}
      data-testid={`wb-rail-${id}`}
    >
      <div
        ref={headRef}
        className="wb-tile-head"
        onContextMenu={(event) => {
          event.preventDefault()
          openMenu()
        }}
        onKeyDown={(event) => {
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            event.preventDefault()
            openMenu()
          }
        }}
      >
        <span className="wb-rail-grip" onPointerDownCapture={grip.onPointerDown}>
          <IconButton
            variant="ghost"
            size="sm"
            aria-label={grip.label}
            aria-pressed={grip.picked}
            onPress={grip.onPress}
            onKeyDown={grip.onKeyDown}
            onBlur={grip.onBlur}
            data-testid={`wb-rail-grip-${id}`}
          >
            <GripVertical size={12} aria-hidden />
          </IconButton>
        </span>
        <Button variant="ghost" size="sm" className="wb-tile-toggle" aria-expanded={open} onPress={() => onOpenChange(!open)}>
          <span className="wb-tile-title">{title}</span>
          {open ? <ChevronDown size={12} className="wb-tile-chevron" aria-hidden /> : <ChevronRight size={12} className="wb-tile-chevron" aria-hidden />}
          {summary != null ? <span className="wb-tile-summary">{summary}</span> : null}
        </Button>
        {onOpenView ? (
          <IconButton variant="ghost" size="sm" aria-label={openLabel ?? title} className="wb-tile-open" onPress={onOpenView}>
            <ArrowUpRight size={13} aria-hidden />
          </IconButton>
        ) : null}
      </div>
      {!open || children == null ? null : <div className="wb-tile-body">{children}</div>}
    </section>
  )
}
