import { useRef, type KeyboardEvent, type PointerEvent, type ReactElement, type ReactNode } from 'react'
import { ArrowUpRight, GripVertical } from 'lucide-react'
import { Button, CollapsibleChevron, IconButton } from '../../ui'
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
  summaryWhenOpen?: boolean
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
  summaryWhenOpen,
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
  const hasBody = children != null
  const showSummary = summary != null && (!open || !hasBody || summaryWhenOpen === true)
  const openMenu = (): void => {
    if (headRef.current) onHeaderMenu(headRef.current)
  }
  return (
    <section
      className="wb-tile"
      data-rail-section={id}
      data-tile={id}
      data-folded={open && hasBody ? '0' : '1'}
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
        <Button variant="plain" size="sm" justify="start" className="wb-tile-toggle" aria-expanded={open} onPress={() => onOpenChange(!open)}>
          <span className="wb-tile-title">{title}</span>
          <CollapsibleChevron expanded={open} className="wb-tile-chevron" />
          {showSummary ? <span className="wb-tile-summary">{summary}</span> : null}
        </Button>
        <span className="wb-rail-grip" data-with-open={onOpenView ? '1' : undefined} onPointerDownCapture={grip.onPointerDown}>
          <IconButton
            variant="plain"
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
        {onOpenView ? (
          <IconButton variant="plain" size="sm" aria-label={openLabel ?? title} tooltip={openLabel ?? title} className="wb-tile-open" onPress={onOpenView}>
            <ArrowUpRight size={12} aria-hidden />
          </IconButton>
        ) : null}
      </div>
      {open && hasBody ? <div className="wb-tile-body">{children}</div> : null}
    </section>
  )
}
