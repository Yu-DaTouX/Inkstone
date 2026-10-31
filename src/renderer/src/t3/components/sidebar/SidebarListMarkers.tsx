import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ChevronDownIcon } from 'lucide-react'
import { type ReactNode, useLayoutEffect } from 'react'
import { cn } from '../../lib/utils'
import {
  animateSidebarLayoutChanges,
  sidebarMarkerId,
  type SidebarListMarker
} from '../Sidebar.logic'

const MARKER_SORTABLE_DISABLED = { draggable: true } as const

const SHELF_HEADER_TONES = {
  muted: { label: 'text-sidebar-muted-foreground' },
  emphasized: { label: 'text-sidebar-foreground/80' },
  accent: { label: 'text-primary' }
} as const

function SortableSidebarMarker(props: {
  marker: SidebarListMarker
  className?: string
  children?: ReactNode
  revealOverflow?: boolean
  'data-testid'?: string
}) {
  const { node, setNodeRef, transform, transition } = useSortable({
    id: sidebarMarkerId(props.marker),
    disabled: MARKER_SORTABLE_DISABLED,
    animateLayoutChanges: animateSidebarLayoutChanges
  })
  useLayoutEffect(() => {
    if (props.revealOverflow && transform?.y !== undefined) {
      node.current?.firstElementChild?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
  }, [node, props.revealOverflow, transform?.y])
  return (
    <li
      ref={setNodeRef}
      data-thread-selection-safe
      data-testid={props['data-testid']}
      className={cn('list-none', props.className)}
      style={{
        transform: CSS.Translate.toString(transform),
        transition: props.marker.endsWith('-placeholder') ? 'none' : transition,
        visibility: transform?.scaleY === 0 ? 'hidden' : undefined
      }}
    >
      {props.children}
    </li>
  )
}

export function SidebarSectionPlaceholder(props: {
  marker: 'active-placeholder' | 'settled-placeholder'
  label: string
  showHint: boolean
  isDropTarget: boolean
}) {
  return (
    <SortableSidebarMarker
      marker={props.marker}
      data-testid={`sidebar-${props.marker}`}
      className="relative mx-0.5 -mb-px h-0"
      revealOverflow={props.marker === 'settled-placeholder' && props.showHint}
    >
      {props.showHint ? (
        <div
          className={cn(
            'absolute inset-x-0 top-0 flex h-9 items-center justify-center rounded-md border border-dashed border-sidebar-foreground/25 text-xs text-sidebar-foreground/80',
            props.isDropTarget && 'border-primary/40 bg-primary/5 text-primary'
          )}
        >
          {props.label}
        </div>
      ) : null}
    </SortableSidebarMarker>
  )
}

export function SidebarDragBoundary(props: {
  marker: 'pinned-header' | 'pinned-divider'
  label: string
  visible: boolean
  isDropTarget: boolean
  resting?: boolean
}) {
  const header = props.marker === 'pinned-header'
  return (
    <SortableSidebarMarker
      marker={props.marker}
      data-testid={`sidebar-${props.marker}`}
      data-resting={props.resting || undefined}
      className={cn(
        'pointer-events-none relative mx-0.5',
        props.resting && !header ? 'h-3' : '-mb-px h-0'
      )}
    >
      {props.resting && !props.visible && !header ? (
        <div aria-hidden className="absolute inset-x-2 top-1/2 h-px bg-sidebar-foreground/15" />
      ) : null}
      {props.visible ? (
        <div className="sidebar-drag-boundary-label absolute inset-x-2 top-1 flex h-4 items-center gap-2">
          <span
            className={cn(
              'shrink-0 text-xs font-medium',
              props.isDropTarget ? 'text-primary' : 'text-sidebar-foreground/80'
            )}
          >
            {props.label}
          </span>
          <span
            aria-hidden
            className={cn(
              'h-px flex-1',
              props.isDropTarget ? 'bg-primary/50' : 'bg-sidebar-foreground/25'
            )}
          />
        </div>
      ) : null}
    </SortableSidebarMarker>
  )
}

export function SidebarSectionHeader(props: {
  marker: 'working-header' | 'snoozed-header' | 'settled-header'
  label: string
  count: number
  className?: string
  dragging?: boolean
  isDropTarget?: boolean
  toggle: { expanded: boolean; onToggle: () => void }
  undoNotice?: ReactNode
}) {
  const shelf =
    props.marker === 'working-header'
      ? 'working'
      : props.marker === 'snoozed-header'
        ? 'snoozed'
        : 'settled'
  const tone = props.isDropTarget ? 'accent' : props.dragging ? 'emphasized' : 'muted'
  return (
    <SortableSidebarMarker
      marker={props.marker}
      data-testid={`sidebar-${props.marker}`}
      className={cn('relative mx-0.5 h-8', props.className)}
    >
      {props.undoNotice ? (
        <div className="absolute inset-x-0 bottom-full bg-sidebar surface-grain">{props.undoNotice}</div>
      ) : null}
      <button
        type="button"
        role="treeitem"
        tabIndex={-1}
        aria-expanded={props.toggle.expanded}
        data-sidebar-row={`shelf:${shelf}`}
        data-testid={`sidebar-${shelf}-shelf-toggle`}
        onClick={props.toggle.onToggle}
        className={cn(
          'flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70',
          SHELF_HEADER_TONES[tone].label
        )}
      >
        <span className="shrink-0">{props.label}</span>
        <span aria-hidden className="h-px min-w-2 flex-1" />
        <span className="shrink-0 font-normal tabular-nums">{props.count}</span>
        <ChevronDownIcon
          aria-hidden
          className={cn(
            'size-3 shrink-0 transition-transform',
            !props.toggle.expanded && '-rotate-90'
          )}
        />
      </button>
    </SortableSidebarMarker>
  )
}

export function SidebarShowMoreRow(props: {
  label: string
  disabled: boolean
  onShowMore: () => void
}) {
  return (
    <li className="list-none">
      <button
        type="button"
        role="treeitem"
        tabIndex={-1}
        data-sidebar-row="settled:more"
        data-sidebar-parent="shelf:settled"
        disabled={props.disabled}
        onClick={props.onShowMore}
        className="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground disabled:cursor-default"
      >
        <ChevronDownIcon aria-hidden className="size-4 shrink-0" />
        {props.label}
      </button>
    </li>
  )
}
