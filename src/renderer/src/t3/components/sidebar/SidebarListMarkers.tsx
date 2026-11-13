import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ChevronDownIcon } from '../../../ui/icons'
import { type ReactNode, useLayoutEffect } from 'react'
import { cx } from '../../../ui/cx'
import {
  animateSidebarLayoutChanges,
  sidebarMarkerId,
  type SidebarListMarker
} from '../Sidebar.logic'
import './SidebarListMarkers.css'

const MARKER_SORTABLE_DISABLED = { draggable: true } as const

const SHELF_HEADER_TONES = {
  muted: { label: '' },
  emphasized: { label: 't3-shelf-toggle--emphasized' },
  accent: { label: 't3-shelf-toggle--drop-target' }
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
      className={cx('t3-marker', props.className)}
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
      className="t3-marker--placeholder"
      revealOverflow={props.marker === 'settled-placeholder' && props.showHint}
    >
      {props.showHint ? (
        <div
          className={cx(
            't3-marker__drop-zone',
            props.isDropTarget && 't3-marker__drop-zone--active'
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
      className={cx('t3-marker--boundary', props.resting && !header && 't3-marker--resting')}
    >
      {props.resting && !props.visible && !header ? (
        <div aria-hidden className="t3-marker__divider" />
      ) : null}
      {props.visible ? (
        <div className={cx('sidebar-drag-boundary-label t3-marker__boundary-label', props.isDropTarget && 't3-marker__boundary-label--active')}>
          <span className="t3-marker__boundary-text">{props.label}</span>
          <span aria-hidden className="t3-marker__boundary-rule" />
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
      className={cx('t3-marker--header', props.className)}
    >
      {props.undoNotice ? (
        <div className="t3-marker__undo surface-grain">{props.undoNotice}</div>
      ) : null}
      <button
        type="button"
        role="treeitem"
        tabIndex={-1}
        aria-expanded={props.toggle.expanded}
        data-sidebar-row={`shelf:${shelf}`}
        data-testid={`sidebar-${shelf}-shelf-toggle`}
        onClick={props.toggle.onToggle}
        className={cx(
          't3-shelf-toggle',
          SHELF_HEADER_TONES[tone].label
        )}
      >
        <span className="t3-icon">{props.label}</span>
        <span aria-hidden className="t3-shelf-toggle__spacer" />
        <span className="t3-shelf-toggle__count">{props.count}</span>
        <ChevronDownIcon
          aria-hidden
          className={cx(
            't3-icon--xs t3-chevron',
            !props.toggle.expanded && 't3-chevron--collapsed'
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
    <li className="t3-marker">
      <button
        type="button"
        role="treeitem"
        tabIndex={-1}
        data-sidebar-row="settled:more"
        data-sidebar-parent="shelf:settled"
        disabled={props.disabled}
        onClick={props.onShowMore}
        className="t3-show-more"
      >
        <ChevronDownIcon aria-hidden className="t3-icon--md" />
        {props.label}
      </button>
    </li>
  )
}
