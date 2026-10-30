import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState
} from 'react'
import { useOptionalT } from '@/i18n'
import { Button } from '@/t3/components/ui/button'
import { Menu, MenuItem, MenuPopup, MenuShortcut, MenuTrigger } from '@/t3/components/ui/menu'
import { ScrollArea } from '@/t3/components/ui/scroll-area'
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/t3/components/ui/tooltip'
import { cn } from '@/t3/lib/utils'
import {
  DisabledReasonTooltip,
  type LauncherAction,
  surfaceShortcutActionForKey
} from './Launcher'
import { TabChip, type TabSurface } from './TabChip'

const TAB_SCROLL_EDGE_TOLERANCE = 1
const TAB_DRAG_THRESHOLD = 4

function tabScrollViewport(root: HTMLDivElement | null): HTMLDivElement | null {
  return root?.querySelector<HTMLDivElement>('[data-slot="scroll-area-viewport"]') ?? null
}

function chipsOf(root: HTMLDivElement | null): HTMLElement[] {
  return [...(root?.querySelectorAll<HTMLElement>('[data-tab-id]') ?? [])]
}

function labelButtonOf(chip: HTMLElement | null | undefined): HTMLButtonElement | null {
  return chip?.querySelector<HTMLButtonElement>('button[role="tab"]') ?? null
}

interface TabScrollState {
  hasOverflow: boolean
  canScrollLeft: boolean
  canScrollRight: boolean
}

const NO_OVERFLOW: TabScrollState = { hasOverflow: false, canScrollLeft: false, canScrollRight: false }

export interface TabStripProps {
  tabs: readonly TabSurface[]
  activeId: string | null
  actions: readonly LauncherAction[]
  showAdd?: boolean
  addMenuOpen?: boolean
  onAddMenuOpenChange?: (open: boolean) => void
  addLabel?: string
  listLabel?: string
  className?: string
  onActivate: (id: string) => void
  onClose: (id: string) => void
  onContextMenu: (id: string, anchor: HTMLElement) => void
  onMove?: (id: string, toIndex: number) => void
}

function AddSurfaceMenuAction(props: { action: LauncherAction }) {
  const { action } = props
  const entry = (
    <MenuItem
      className={action.available ? undefined : 'data-disabled:pointer-events-auto'}
      disabled={!action.available}
      aria-keyshortcuts={action.shortcut}
      onClick={() => {
        if (!action.available) return
        action.onPick()
      }}
    >
      {action.icon}
      <span className="min-w-0 flex-1 truncate">{action.label}</span>
      <MenuShortcut>{action.shortcut}</MenuShortcut>
    </MenuItem>
  )
  if (action.available || !action.disabledReason) return entry
  return <DisabledReasonTooltip reason={action.disabledReason} trigger={entry} />
}

export function TabStrip(props: TabStripProps) {
  const t = useOptionalT()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [scroll, setScroll] = useState<TabScrollState>(NO_OVERFLOW)
  const [addMenuInternalOpen, setAddMenuInternalOpen] = useState(false)
  const addMenuOpen = props.addMenuOpen ?? addMenuInternalOpen
  const setAddMenuOpen = props.onAddMenuOpenChange ?? setAddMenuInternalOpen
  const [drag, setDrag] = useState<{ id: string; offsetX: number } | null>(null)
  const dragCleanupRef = useRef<(() => void) | null>(null)

  useEffect(() => () => dragCleanupRef.current?.(), [])

  const updateScrollState = useCallback((viewport: HTMLDivElement) => {
    const hasOverflow = viewport.scrollWidth - viewport.clientWidth > TAB_SCROLL_EDGE_TOLERANCE
    const canScrollLeft = hasOverflow && viewport.scrollLeft > TAB_SCROLL_EDGE_TOLERANCE
    const canScrollRight =
      hasOverflow &&
      viewport.scrollLeft + viewport.clientWidth < viewport.scrollWidth - TAB_SCROLL_EDGE_TOLERANCE
    setScroll((current) =>
      current.hasOverflow === hasOverflow &&
      current.canScrollLeft === canScrollLeft &&
      current.canScrollRight === canScrollRight
        ? current
        : { hasOverflow, canScrollLeft, canScrollRight }
    )
  }, [])

  const attachTabList = useCallback(
    (root: HTMLDivElement | null) => {
      rootRef.current = root
      const viewport = tabScrollViewport(root)
      if (!viewport) return

      const update = () => updateScrollState(viewport)
      const handleWheel = (event: WheelEvent) => {
        if (event.ctrlKey) return
        let delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
        if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) delta *= 16
        if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) delta *= viewport.clientWidth
        if (delta === 0) return
        const previousScrollLeft = viewport.scrollLeft
        viewport.scrollLeft += delta
        if (viewport.scrollLeft === previousScrollLeft) return
        event.preventDefault()
        update()
      }

      const content = viewport.firstElementChild
      const observer = new ResizeObserver(update)
      observer.observe(viewport)
      if (content) observer.observe(content)
      viewport.addEventListener('scroll', update, { passive: true })
      viewport.addEventListener('wheel', handleWheel, { passive: false })
      update()

      return () => {
        rootRef.current = null
        observer.disconnect()
        viewport.removeEventListener('scroll', update)
        viewport.removeEventListener('wheel', handleWheel)
      }
    },
    [updateScrollState]
  )

  useEffect(() => {
    if (!props.activeId || !scroll.hasOverflow) return
    const active = chipsOf(rootRef.current).find((chip) => chip.dataset.activeTab === 'true')
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [props.activeId, scroll.hasOverflow, props.tabs.length])

  const scrollTabs = (direction: -1 | 1) => {
    const viewport = tabScrollViewport(rootRef.current)
    if (!viewport) return
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    viewport.scrollBy({
      left: direction * Math.max(120, viewport.clientWidth * 0.75),
      behavior: reduceMotion ? 'auto' : 'smooth'
    })
  }

  const focusTabAt = (index: number) => {
    const chips = chipsOf(rootRef.current)
    if (!chips.length) return
    const target = chips[(index + chips.length) % chips.length]
    labelButtonOf(target)?.focus()
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return
    const chip = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-tab-id]') : null
    const chips = chipsOf(rootRef.current)
    const index = chip ? chips.indexOf(chip) : -1
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      if (event.ctrlKey || event.metaKey || event.altKey || index < 0) return
      event.preventDefault()
      focusTabAt(index + (event.key === 'ArrowRight' ? 1 : -1))
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      if (event.ctrlKey || event.metaKey || event.altKey) return
      event.preventDefault()
      focusTabAt(event.key === 'Home' ? 0 : chips.length - 1)
      return
    }
    if (!chip) return
    const id = chip.dataset.tabId
    if (!id) return
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'w') {
      event.preventDefault()
      props.onClose(id)
      return
    }
    if (event.key === 'Delete') {
      event.preventDefault()
      props.onClose(id)
      return
    }
    if (event.key === 'F10' && event.shiftKey) {
      event.preventDefault()
      props.onContextMenu(id, chip)
      return
    }
    if (event.key === 'ContextMenu') {
      event.preventDefault()
      props.onContextMenu(id, chip)
    }
  }

  const onChipPointerDown = (surface: TabSurface) => (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!props.onMove || event.button !== 0) return
    if (event.target instanceof Element && event.target.closest('button[aria-label]')) return
    const chip = event.currentTarget
    const startX = event.clientX
    let moved = false

    const handleMove = (moveEvent: globalThis.PointerEvent) => {
      const offsetX = moveEvent.clientX - startX
      if (!moved && Math.abs(offsetX) < TAB_DRAG_THRESHOLD) return
      moved = true
      setDrag({ id: surface.id, offsetX })
    }

    const stop = () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
      window.removeEventListener('pointercancel', stop)
      dragCleanupRef.current = null
    }

    const handleUp = () => {
      stop()
      if (!moved) {
        setDrag(null)
        return
      }
      const root = rootRef.current
      const dragged = chip.getBoundingClientRect()
      const draggedCentre = dragged.left + dragged.width / 2
      const others = chipsOf(root).filter((entry) => entry.dataset.tabId !== surface.id)
      const toIndex = others.reduce((count, entry) => {
        const rect = entry.getBoundingClientRect()
        return count + (draggedCentre > rect.left + rect.width / 2 ? 1 : 0)
      }, 0)
      setDrag(null)
      props.onMove?.(surface.id, toIndex)
    }

    dragCleanupRef.current = stop
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
    window.addEventListener('pointercancel', stop)
  }

  const closeLabelOf = (surface: TabSurface) =>
    t('panel.t3.closeTab', { name: surface.label })

  const handleAddMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const action = surfaceShortcutActionForKey(props.actions, event.nativeEvent)
    if (!action) return
    event.preventDefault()
    event.stopPropagation()
    setAddMenuOpen(false)
    action.onPick()
  }

  return (
    <div className={cn('flex h-full min-w-0 flex-1 items-center gap-1', props.className)}>
      <ScrollArea
        radius="none"
        ref={attachTabList}
        hideScrollbars
        scrollFade
        className="min-w-0 flex-1"
        data-right-panel-tab-list
      >
        <div className="flex h-full w-max min-w-full items-center gap-1">
          <div
            role="tablist"
            aria-label={props.listLabel ?? t('panel.t3.tabs')}
            className="flex items-center gap-1"
            onKeyDown={onKeyDown}
          >
            {props.tabs.map((surface) => (
              <TabChip
                key={surface.id}
                surface={surface}
                active={surface.id === props.activeId}
                controls={`rp-surface-${surface.id}`}
                closeLabel={closeLabelOf(surface)}
                dragging={drag?.id === surface.id}
                offsetX={drag?.id === surface.id ? drag.offsetX : 0}
                onActivate={() => props.onActivate(surface.id)}
                onClose={() => props.onClose(surface.id)}
                onContextMenu={(anchor) => props.onContextMenu(surface.id, anchor)}
                onPointerDown={onChipPointerDown(surface)}
              />
            ))}
          </div>
          {props.showAdd === false ? null : (
            <Menu open={addMenuOpen} onOpenChange={setAddMenuOpen}>
              <MenuTrigger
                render={
                  <Button
                    aria-label={props.addLabel ?? t('panel.t3.addSurface')}
                    className="shrink-0"
                    data-testid="rp-new-tab"
                    size="icon-xs"
                    variant="ghost-muted"
                  />
                }
              >
                <Plus className="size-3.5" />
              </MenuTrigger>
              <MenuPopup
                align="start"
                side="bottom"
                sideOffset={6}
                onKeyDownCapture={handleAddMenuKeyDown}
              >
                {props.actions.map((action) => (
                  <AddSurfaceMenuAction key={action.kind} action={action} />
                ))}
              </MenuPopup>
            </Menu>
          )}
        </div>
      </ScrollArea>
      {scroll.hasOverflow ? (
        <div
          className="flex shrink-0 items-center gap-0.5"
          role="group"
          aria-label={props.listLabel ?? t('panel.t3.tabs')}
        >
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="inline-flex">
                  <Button
                    aria-label={t('panel.t3.scrollLeft')}
                    disabled={!scroll.canScrollLeft}
                    onClick={() => scrollTabs(-1)}
                    size="icon-xs"
                    variant="ghost"
                  >
                    <ChevronLeft />
                  </Button>
                </span>
              }
            />
            <TooltipPopup>{t('panel.t3.scrollLeft')}</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="inline-flex">
                  <Button
                    aria-label={t('panel.t3.scrollRight')}
                    disabled={!scroll.canScrollRight}
                    onClick={() => scrollTabs(1)}
                    size="icon-xs"
                    variant="ghost"
                  >
                    <ChevronRight />
                  </Button>
                </span>
              }
            />
            <TooltipPopup>{t('panel.t3.scrollRight')}</TooltipPopup>
          </Tooltip>
        </div>
      ) : null}
    </div>
  )
}
