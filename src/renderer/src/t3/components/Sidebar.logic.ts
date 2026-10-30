import { defaultAnimateLayoutChanges, type AnimateLayoutChanges } from '@dnd-kit/sortable'

export const animateSidebarLayoutChanges: AnimateLayoutChanges = (args) =>
  args.isSorting ? defaultAnimateLayoutChanges(args) : false

export function isTrailingDoubleClick(detail: number): boolean {
  return detail > 1
}

export function resolveSidebarRowAccessibility(input: {
  readonly title: string
  readonly statusLabel: string | null
  readonly projectDisplayName: string | null
  readonly isActive: boolean
}): { readonly label: string; readonly current: 'page' | undefined } {
  return {
    label: [input.title, input.statusLabel, input.projectDisplayName].filter(Boolean).join(', '),
    current: input.isActive ? 'page' : undefined
  }
}

export type SidebarSection = 'pinned' | 'active' | 'working' | 'snoozed' | 'settled'

export const SIDEBAR_SECTIONS: readonly SidebarSection[] = [
  'pinned',
  'active',
  'working',
  'snoozed',
  'settled'
]

export function resolveSidebarThreadSection(input: {
  readonly snoozed: boolean
  readonly settled: boolean
  readonly pinned: boolean
  readonly working?: boolean
}): SidebarSection {
  if (input.working) return 'working'
  if (input.snoozed) return 'snoozed'
  if (input.settled) return 'settled'
  if (input.pinned) return 'pinned'
  return 'active'
}

const SIDEBAR_MARKER_PREFIX = 'sidebar-marker-'

export type SidebarListMarker =
  | 'pinned-header'
  | 'active-placeholder'
  | 'settled-placeholder'
  | 'pinned-divider'
  | 'working-header'
  | 'snoozed-header'
  | 'settled-header'

export function sidebarMarkerId(marker: SidebarListMarker): string {
  return `${SIDEBAR_MARKER_PREFIX}${marker}`
}

export type SidebarListItem =
  | { readonly kind: 'thread'; readonly key: string; readonly section: SidebarSection }
  | { readonly kind: 'marker'; readonly marker: SidebarListMarker }

export function sidebarListItemId(item: SidebarListItem): string {
  return item.kind === 'thread' ? item.key : sidebarMarkerId(item.marker)
}

export function sidebarFolderRowId(projectKey: string): string {
  return `folder:${projectKey}`
}

function sectionAtSidebarSlot(items: readonly SidebarListItem[], index: number): SidebarSection {
  let section: SidebarSection = 'pinned'
  for (let i = 0; i < index && i < items.length; i += 1) {
    const item = items[i]!
    if (item.kind !== 'marker') continue
    if (item.marker === 'pinned-divider') section = 'active'
    else if (item.marker === 'working-header') section = 'working'
    else if (item.marker === 'snoozed-header') section = 'snoozed'
    else if (item.marker === 'settled-header') section = 'settled'
  }
  return section
}

export type SidebarDropTarget = {
  readonly section: 'pinned' | 'active' | 'settled'
  readonly pinnedOrder: readonly string[]
  readonly activeOrder: readonly string[]
}

export function resolveSidebarDropTarget(
  items: readonly SidebarListItem[],
  activeKey: string,
  overId: string
): SidebarDropTarget | null {
  const activeIndex = items.findIndex((item) => sidebarListItemId(item) === activeKey)
  const overIndex = items.findIndex((item) => sidebarListItemId(item) === overId)
  if (activeIndex === -1 || overIndex === -1 || items[activeIndex]?.kind !== 'thread') return null
  const moved = items.filter((_, index) => index !== activeIndex)
  moved.splice(overIndex, 0, items[activeIndex]!)
  const section = sectionAtSidebarSlot(moved, overIndex)
  if (section === 'working' || section === 'snoozed') return null
  const pinnedOrder: string[] = []
  const activeOrder: string[] = []
  let currentSection: SidebarSection = 'pinned'
  for (const item of moved) {
    if (item.kind === 'marker') {
      if (item.marker === 'pinned-divider') currentSection = 'active'
      else if (
        item.marker === 'working-header' ||
        item.marker === 'snoozed-header' ||
        item.marker === 'settled-header'
      )
        break
    } else if (currentSection === 'pinned') pinnedOrder.push(item.key)
    else activeOrder.push(item.key)
  }
  return { section, pinnedOrder, activeOrder }
}

export type SidebarDropVerb = 'pin' | 'unpin' | 'archive' | 'unarchive' | 'wake'

export function resolveSidebarDropVerb(
  from: SidebarSection,
  to: SidebarSection | null
): SidebarDropVerb | null {
  if (to === null || to === from || to === 'working' || to === 'snoozed') return null
  if (to === 'pinned') return 'pin'
  if (to === 'settled') return 'archive'
  if (from === 'pinned') return 'unpin'
  if (from === 'settled') return 'unarchive'
  return 'wake'
}

export type SidebarThreadDropPlan =
  | { readonly kind: 'none' }
  | { readonly kind: 'pin' }
  | { readonly kind: 'archive' }
  | {
      readonly kind: 'move-active'
      readonly unpin: boolean
      readonly unsettle: boolean
      readonly unsnooze: boolean
    }

export function planSidebarThreadDrop(input: {
  readonly activeSection: SidebarSection
  readonly activePinned?: boolean
  readonly activeSettled?: boolean
  readonly target: SidebarDropTarget
}): SidebarThreadDropPlan {
  const {
    activeSection,
    activePinned = activeSection === 'pinned',
    activeSettled = activeSection === 'settled',
    target
  } = input
  if (activeSection === 'working') return { kind: 'none' }
  switch (target.section) {
    case 'active':
      if (activeSection === 'active') return { kind: 'none' }
      return {
        kind: 'move-active',
        unpin: activePinned,
        unsettle: activeSettled,
        unsnooze: activeSection === 'snoozed'
      }
    case 'settled':
      return activeSection === 'settled' ? { kind: 'none' } : { kind: 'archive' }
    case 'pinned':
      return activeSection === 'pinned' ? { kind: 'none' } : { kind: 'pin' }
  }
}

export function buildSidebarListItems(input: {
  readonly pinned: readonly string[]
  readonly active: readonly string[]
  readonly working: readonly string[]
  readonly snoozed: readonly string[]
  readonly settled: readonly string[]
  readonly showWorkingShelf?: boolean
  readonly showSnoozedShelf?: boolean
  readonly showSettledShelf?: boolean
  readonly visibleWorking?: readonly string[]
  readonly visibleSnoozed?: readonly string[]
}): readonly SidebarListItem[] {
  const rows = (keys: readonly string[], section: SidebarSection): SidebarListItem[] =>
    keys.map((key) => ({ kind: 'thread', key, section }))
  const items: SidebarListItem[] = []
  if (input.pinned.length > 0 || input.active.length > 0) {
    items.push({ kind: 'marker', marker: 'pinned-header' })
    items.push(...rows(input.pinned, 'pinned'))
    items.push({ kind: 'marker', marker: 'pinned-divider' })
  }
  items.push({ kind: 'marker', marker: 'active-placeholder' })
  items.push(...rows(input.active, 'active'))
  if (input.showWorkingShelf !== false && input.working.length > 0) {
    items.push({ kind: 'marker', marker: 'working-header' })
    items.push(...rows(input.visibleWorking ?? input.working, 'working'))
  }
  if (input.showSnoozedShelf !== false && input.snoozed.length > 0) {
    items.push({ kind: 'marker', marker: 'snoozed-header' })
    items.push(...rows(input.visibleSnoozed ?? input.snoozed, 'snoozed'))
  }
  if (input.showSettledShelf !== false) {
    items.push({ kind: 'marker', marker: 'settled-header' })
    items.push({ kind: 'marker', marker: 'settled-placeholder' })
    items.push(...rows(input.settled, 'settled'))
  }
  return items
}

export function sidebarThreadKeyAtY(list: HTMLElement, y: number): string | null {
  const viewport = list.closest('[data-slot="scroll-area-viewport"]')?.getBoundingClientRect()
  const visibleY = viewport ? Math.min(Math.max(y, viewport.top), viewport.bottom - 1) : y
  let key: string | null = null
  for (const row of list.querySelectorAll<HTMLElement>('li[data-thread-item]')) {
    if (key !== null && row.getBoundingClientRect().top > visibleY) break
    key = row.dataset.threadItem ?? null
  }
  return key
}
