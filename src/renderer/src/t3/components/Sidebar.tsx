import {
  DndContext,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type Modifier
} from '@dnd-kit/core'
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from '@dnd-kit/modifiers'
import { SortableContext, useSortable } from '@dnd-kit/sortable'
import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { cn } from '../lib/utils'
import { attachSidebarTree, sidebarTreeProps } from '../lib/sidebarTree'
import {
  animateSidebarLayoutChanges,
  buildSidebarListItems,
  planSidebarThreadDrop,
  resolveSidebarDropTarget,
  resolveSidebarDropVerb,
  sidebarFolderRowId,
  sidebarListItemId,
  type SidebarDropTarget,
  type SidebarDropVerb,
  type SidebarSection,
  type SidebarThreadDropPlan
} from './Sidebar.logic'
import {
  createSidebarCollisionDetection,
  createSidebarSortingStrategy,
  restrictBelowSidebarLabel
} from './Sidebar.drag'
import { SidebarPointerSensor } from './Sidebar.pointer'
import { createSidebarListMotion } from './Sidebar.motion'
import {
  SidebarDragBoundary,
  SidebarSectionHeader,
  SidebarSectionPlaceholder,
  SidebarShowMoreRow
} from './sidebar/SidebarListMarkers'
import {
  SidebarProjectFolderHeader,
  type SidebarProjectFolderView
} from './sidebar/SidebarProjectFolderHeader'
import type { SidebarSortableBag } from './sidebar/SidebarThreadRow'

const SIDEBAR_DRAG_DISTANCE = 6
const SIDEBAR_DRAG_LABEL_HEIGHT = 24

export type SidebarRowVariant = 'card' | 'slim' | 'folder' | 'folder-multiline'

export interface SidebarThreadSections {
  pinned: readonly string[]
  active: readonly string[]
  working: readonly string[]
  snoozed: readonly string[]
  settled: readonly string[]
}

export interface SidebarRowRenderProps {
  threadKey: string
  section: SidebarSection
  variant: SidebarRowVariant
  navigationParent?: string
  dropVerb: SidebarDropVerb | null
  sortable: SidebarSortableBag
}

function SortableRowSlot(props: {
  rowId: string
  disabled: boolean
  render: (sortable: SidebarSortableBag) => ReactNode
}) {
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({
    id: props.rowId,
    disabled: props.disabled ? { draggable: true, droppable: false } : false,
    animateLayoutChanges: animateSidebarLayoutChanges
  })
  return props.render({
    setNodeRef,
    listeners: listeners as SidebarSortableBag['listeners'],
    transform: transform === null ? null : { x: transform.x, y: transform.y },
    transition: transition ?? null,
    isDragging
  })
}

export interface SidebarDropInput {
  threadKey: string
  from: SidebarSection
  target: SidebarDropTarget
  plan: SidebarThreadDropPlan
}

export interface SidebarThreadListProps {
  sections: SidebarThreadSections
  labels: {
    tree: string
    pinned: string
    active: string
    working: string
    snoozed: string
    settled: string
  }
  renderRow: (props: SidebarRowRenderProps) => ReactNode
  onDropPlan: (input: SidebarDropInput) => void
  shelves?: { working: boolean; snoozed: boolean; settled: boolean }
  onToggleShelf?: (shelf: 'working' | 'snoozed' | 'settled') => void
  showSettledShelf?: boolean
  settledCount?: number
  settledExpanded?: boolean
  settledVisibleCount?: number
  settledRouteThreadKey?: string | null
  showMore?: { label: string; disabled: boolean; onShowMore: () => void }
  projectFolders?: readonly SidebarProjectFolderView[] | null
  folderRowsMultiline?: boolean
  onToggleFolder?: (projectKey: string) => void
  onNewThreadInFolder?: (projectKey: string) => void
  onFolderContextMenu?: (projectKey: string, position: { x: number; y: number }) => void
  folderNewThreadLabel?: (projectKey: string) => string
  folderMenuLabel?: string
  draftRows?: ReactNode
  draftKey?: string
  undoNotice?: ReactNode
  emptyState?: ReactNode
  onMoveOutside?: (point: { x: number; y: number }, threadKey: string) => boolean
  onDropOutside?: (point: { x: number; y: number }, threadKey: string) => boolean
  onDragFinish?: () => void
  className?: string
}

export function SidebarThreadList(props: SidebarThreadListProps) {
  const { sections, labels, renderRow } = props
  const hasProjectFolders = props.projectFolders != null && props.projectFolders.length > 0
  const shelves = props.shelves ?? { working: true, snoozed: true, settled: true }
  const hasAnyRow =
    sections.pinned.length +
      sections.active.length +
      sections.working.length +
      sections.snoozed.length +
      sections.settled.length >
    0

  const items = useMemo(
    () =>
      hasAnyRow || hasProjectFolders
        ? buildSidebarListItems({
            pinned: sections.pinned,
            active: sections.active,
            working: sections.working,
            snoozed: sections.snoozed,
            settled: shelves.settled ? sections.settled : [],
            visibleWorking: shelves.working ? sections.working : [],
            visibleSnoozed: shelves.snoozed ? sections.snoozed : [],
            showSettledShelf: props.showSettledShelf !== false
          })
        : [],
    [
      hasAnyRow,
      hasProjectFolders,
      sections.pinned,
      sections.active,
      sections.working,
      sections.snoozed,
      sections.settled,
      shelves.working,
      shelves.snoozed,
      shelves.settled,
      props.showSettledShelf
    ]
  )

  const sectionByThreadKey = useMemo(() => {
    const map = new Map<string, SidebarSection>()
    for (const item of items) {
      if (item.kind === 'thread') map.set(item.key, item.section)
    }
    return map
  }, [items])

  const listKey = useMemo(
    () =>
      items
        .map((item) => (item.kind === 'thread' ? `${item.section}:${item.key}` : item.marker))
        .join('\n'),
    [items]
  )

  const [dragOutside, setDragOutside] = useState(false)
  const [dragState, setDragState] = useState<{
    activeKey: string
    activeSection: SidebarSection
    targetSection: SidebarSection | null
    activationY: number | null
  } | null>(null)
  const dragSensorRef = useRef<SidebarPointerSensor | null>(null)
  const draggedKeyRef = useRef<string | null>(null)
  const dragLabelOffsetRef = useRef(0)
  const listMotionRef = useRef<ReturnType<typeof createSidebarListMotion> | null>(null)
  const threadListRef = useRef<HTMLUListElement | null>(null)
  const sectionByThreadKeyRef = useRef(sectionByThreadKey)
  const itemsRef = useRef(items)

  useLayoutEffect(() => {
    sectionByThreadKeyRef.current = sectionByThreadKey
    itemsRef.current = items
  })

  const attachTreeRef = useCallback((node: HTMLUListElement | null) => {
    threadListRef.current = node
    if (node === null) return
    const motion = createSidebarListMotion(node)
    listMotionRef.current = motion
    motion.update(false)
    const detachTree = attachSidebarTree(node)
    return () => {
      dragSensorRef.current?.cancel()
      detachTree?.()
      motion.dispose()
      if (listMotionRef.current === motion) listMotionRef.current = null
      if (threadListRef.current === node) threadListRef.current = null
    }
  }, [])

  const folderKey = props.projectFolders?.map((folder) => `${folder.projectKey}:${folder.collapsed ? '' : folder.threadKeys.join(',')}`).join('|')

  useLayoutEffect(() => {
    listMotionRef.current?.update(dragState === null)
  }, [listKey, folderKey, props.draftKey, dragState])

  useEffect(() => {
    if (
      dragState !== null &&
      !items.some((item) => item.kind === 'thread' && item.key === dragState.activeKey)
    ) {
      dragSensorRef.current?.cancel()
    }
  }, [dragState, items])

  const restrictBelowPins: Modifier = (args) =>
    restrictBelowSidebarLabel(args, dragLabelOffsetRef.current)

  const dndModifiers = [
    restrictToVerticalAxis,
    restrictBelowPins,
    restrictToFirstScrollableAncestor
  ]

  const finishThreadDrag = (started: boolean) => {
    dragSensorRef.current = null
    setDragOutside(false)
    draggedKeyRef.current = null
    props.onDragFinish?.()
    if (started) {
      listMotionRef.current?.release()
      setDragState(null)
    }
  }

  const pointerSensorOptions = {
    distance: SIDEBAR_DRAG_DISTANCE,
    onAttach: (sensor: SidebarPointerSensor) => {
      dragSensorRef.current = sensor
    },
    onFinish: finishThreadDrag,
    onMove: (point: { x: number; y: number }) => {
      const outside = draggedKeyRef.current !== null && props.onMoveOutside?.(point, draggedKeyRef.current) === true
      setDragOutside(outside)
      return outside
    },
    onDrop: (point: { x: number; y: number }) => draggedKeyRef.current !== null && props.onDropOutside?.(point, draggedKeyRef.current) === true
  }
  const dndSensors = useSensors(useSensor(SidebarPointerSensor, pointerSensorOptions))

  const handleThreadDragStart = (event: DragStartEvent) => {
    const activeKey = String(event.active.id)
    const activeSection = sectionByThreadKeyRef.current.get(activeKey)
    if (activeSection === undefined) return
    draggedKeyRef.current = activeKey
    listMotionRef.current?.suspend()
    const list = threadListRef.current
    const header = list?.querySelector<HTMLElement>('[data-testid="sidebar-pinned-header"]')
    if (list && header) {
      const listRect = list.getBoundingClientRect()
      const scale = list.offsetWidth > 0 ? listRect.width / list.offsetWidth : 1
      dragLabelOffsetRef.current =
        header.getBoundingClientRect().top - listRect.top + SIDEBAR_DRAG_LABEL_HEIGHT * scale
    } else {
      dragLabelOffsetRef.current = 0
    }
    setDragState({
      activeKey,
      activeSection,
      targetSection: activeSection,
      activationY:
        event.activatorEvent instanceof PointerEvent ? event.activatorEvent.clientY : null
    })
  }

  const handleThreadDragOver = (event: DragOverEvent) => {
    const target = event.over
      ? resolveSidebarDropTarget(itemsRef.current, String(event.active.id), String(event.over.id))
      : null
    setDragState((current) =>
      current === null || current.activeKey !== String(event.active.id)
        ? current
        : { ...current, targetSection: target?.section ?? null }
    )
  }

  const handleThreadDragEnd = (event: DragEndEvent) => {
    const activeKey = String(event.active.id)
    const activeSection = sectionByThreadKeyRef.current.get(activeKey)
    const target =
      event.over === null
        ? null
        : resolveSidebarDropTarget(itemsRef.current, activeKey, String(event.over.id))
    if (activeSection === undefined || target === null) return
    const plan = planSidebarThreadDrop({ activeSection, target })
    if (plan.kind === 'none') return
    props.onDropPlan({ threadKey: activeKey, from: activeSection, target, plan })
  }

  const sortableIds = items.map(sidebarListItemId)
  const sidebarSortingStrategy = createSidebarSortingStrategy({
    items,
    enabled: !dragOutside,
    boundaryLabelHeight: SIDEBAR_DRAG_LABEL_HEIGHT,
    settledOrder: sections.settled,
    activeOrder: hasProjectFolders ? sections.active : undefined,
    settledExpanded: props.settledExpanded ?? shelves.settled,
    settledVisibleCount: props.settledVisibleCount,
    routeThreadKey: props.settledRouteThreadKey ?? null,
    snoozedThreadCount: sections.snoozed.length
  })

  const draggedThreadKey = dragState?.activeKey
  const draggedFromSection = dragState?.activeSection
  const dragActivationY = dragState?.activationY
  const dragTargetSection = dragState?.targetSection ?? null
  const dndCollisionDetection = (() => {
    if (draggedThreadKey === undefined || draggedFromSection === undefined)
      return createSidebarCollisionDetection(() => true)
    return createSidebarCollisionDetection(
      (id) => {
        const target = resolveSidebarDropTarget(items, draggedThreadKey, id)
        if (target === null) return false
        return planSidebarThreadDrop({ activeSection: draggedFromSection, target }).kind !== 'none'
      },
      { items, activationY: dragActivationY ?? null }
    )
  })()

  const rowVariant = (section: SidebarSection, inFolder: boolean): SidebarRowVariant =>
    inFolder
      ? props.folderRowsMultiline
        ? 'folder-multiline'
        : 'folder'
      : section === 'pinned' || section === 'active' || section === 'working'
        ? 'card'
        : 'slim'

  const shelfFirst =
    sections.working.length > 0
      ? 'working'
      : sections.snoozed.length > 0
        ? 'snoozed'
        : sections.settled.length > 0
          ? 'settled'
          : null

  const nodes: ReactNode[] = []
  if (props.draftRows) {
    nodes.push(<Fragment key="draft-sessions">{props.draftRows}</Fragment>)
  }
  const rowDisabled = (section: SidebarSection, inFolder: boolean) =>
    inFolder || section === 'working'
  for (const item of items) {
    if (item.kind === 'thread') {
      if (hasProjectFolders && item.section === 'active') continue
      nodes.push(
        <SortableRowSlot
          key={item.key}
          rowId={item.key}
          disabled={rowDisabled(item.section, false)}
          render={(sortable) =>
            renderRow({
              threadKey: item.key,
              section: item.section,
              variant: rowVariant(item.section, false),
              navigationParent:
                item.section === 'working' ||
                item.section === 'snoozed' ||
                item.section === 'settled'
                  ? `shelf:${item.section}`
                  : undefined,
              dropVerb:
                dragState?.activeKey === item.key
                  ? resolveSidebarDropVerb(dragState.activeSection, dragTargetSection)
                  : null,
              sortable
            })
          }
        />
      )
      continue
    }
    const from = dragState?.activeSection ?? null
    switch (item.marker) {
      case 'pinned-header':
        nodes.push(
          <SidebarDragBoundary
            key="pinned-header"
            marker="pinned-header"
            label={labels.pinned}
            visible={from !== null && !dragOutside}
            isDropTarget={dragTargetSection === 'pinned'}
            resting={sections.pinned.length > 0}
          />
        )
        break
      case 'pinned-divider':
        nodes.push(
          <SidebarDragBoundary
            key="pinned-divider"
            marker="pinned-divider"
            label={labels.active}
            visible={from !== null && !dragOutside}
            isDropTarget={dragTargetSection === 'active'}
            resting={sections.pinned.length > 0}
          />
        )
        break
      case 'active-placeholder':
        if (hasProjectFolders) {
          for (const folder of props.projectFolders ?? []) {
            nodes.push(
              <SidebarProjectFolderHeader
                key={`project-folder:${folder.projectKey}`}
                folder={folder}
                newThreadLabel={props.folderNewThreadLabel?.(folder.projectKey) ?? folder.displayName}
                menuLabel={props.folderMenuLabel ?? folder.displayName}
                onToggle={(projectKey) => props.onToggleFolder?.(projectKey)}
                onNewThread={(projectKey) => props.onNewThreadInFolder?.(projectKey)}
                onContextMenu={(projectKey, position) =>
                  props.onFolderContextMenu?.(projectKey, position)
                }
              />
            )
            if (folder.collapsed) continue
            for (const threadKey of folder.threadKeys) {
              nodes.push(
                <SortableRowSlot
                  key={`${folder.projectKey}:${threadKey}`}
                  rowId={threadKey}
                  disabled
                  render={(sortable) =>
                    renderRow({
                      threadKey,
                      section: 'active',
                      variant: rowVariant('active', true),
                      navigationParent: sidebarFolderRowId(folder.projectKey),
                      dropVerb: null,
                      sortable
                    })
                  }
                />
              )
            }
          }
          break
        }
        nodes.push(
          <SidebarSectionPlaceholder
            key="active-placeholder"
            marker="active-placeholder"
            label={labels.active}
            showHint={
              from !== null &&
              (sections.active.length === 0 ||
                (from === 'active' &&
                  sections.active.length === 1 &&
                  dragTargetSection !== null &&
                  dragTargetSection !== 'active'))
            }
            isDropTarget={dragTargetSection === 'active'}
          />
        )
        break
      case 'working-header':
        nodes.push(
          <SidebarSectionHeader
            key="working-shelf-header"
            marker="working-header"
            className={shelfFirst === 'working' ? 'mt-auto' : undefined}
            label={labels.working}
            count={sections.working.length}
            undoNotice={shelfFirst === 'working' ? props.undoNotice : undefined}
            toggle={{
              expanded: shelves.working,
              onToggle: () => props.onToggleShelf?.('working')
            }}
          />
        )
        break
      case 'snoozed-header':
        nodes.push(
          <SidebarSectionHeader
            key="snoozed-shelf-header"
            marker="snoozed-header"
            className={shelfFirst === 'snoozed' ? 'mt-auto' : undefined}
            label={labels.snoozed}
            count={sections.snoozed.length}
            undoNotice={shelfFirst === 'snoozed' ? props.undoNotice : undefined}
            toggle={{
              expanded: shelves.snoozed,
              onToggle: () => props.onToggleShelf?.('snoozed')
            }}
          />
        )
        break
      case 'settled-header':
        nodes.push(
          <SidebarSectionHeader
            key="settled-shelf-header"
            marker="settled-header"
            className={shelfFirst === 'settled' ? 'mt-auto' : undefined}
            label={labels.settled}
            count={props.settledCount ?? sections.settled.length}
            dragging={from !== null}
            isDropTarget={dragTargetSection === 'settled'}
            undoNotice={shelfFirst === 'settled' ? props.undoNotice : undefined}
            toggle={{
              expanded: props.settledExpanded ?? shelves.settled,
              onToggle: () => props.onToggleShelf?.('settled')
            }}
          />
        )
        break
      case 'settled-placeholder':
        nodes.push(
          <SidebarSectionPlaceholder
            key="settled-placeholder"
            marker="settled-placeholder"
            label={labels.settled}
            showHint={
              from !== null &&
              (sections.settled.length === 0 ||
                (from === 'settled' &&
                  sections.settled.length === 1 &&
                  dragTargetSection !== null &&
                  dragTargetSection !== 'settled'))
            }
            isDropTarget={dragTargetSection === 'settled'}
          />
        )
        break
    }
  }
  if (props.showMore && (props.settledExpanded ?? shelves.settled)) {
    nodes.push(
      <SidebarShowMoreRow
        key="settled-show-more"
        label={props.showMore.label}
        disabled={props.showMore.disabled}
        onShowMore={props.showMore.onShowMore}
      />
    )
  }

  return (
    <DndContext
      sensors={dndSensors}
      collisionDetection={dndCollisionDetection}
      modifiers={dndModifiers}
      onDragStart={handleThreadDragStart}
      onDragOver={handleThreadDragOver}
      onDragEnd={handleThreadDragEnd}
    >
      <SortableContext items={sortableIds} strategy={sidebarSortingStrategy}>
        <ul
          {...sidebarTreeProps(labels.tree)}
          ref={attachTreeRef}
          className={cn('relative flex flex-col gap-px', items.length > 0 && 'flex-1', props.className)}
        >
          {nodes}
        </ul>
      </SortableContext>
      {props.emptyState}
    </DndContext>
  )
}

