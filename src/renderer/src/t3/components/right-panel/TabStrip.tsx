import { ChevronDown, Plus } from 'lucide-react'
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState
} from 'react'
import { useOptionalT } from '@/i18n'
import { Button, Header, IconButton, Kbd, Menu, MenuItem, MenuSection, MenuTrigger, Popover, ScrollArea } from '../../../ui'
import { cx } from '@/ui/cx'
import {
  type LauncherAction,
  surfaceShortcutActionForKey
} from './Launcher'
import { SurfaceIcon, TabChip, type TabSurface } from './TabChip'
import './TabStrip.css'

const TAB_SCROLL_EDGE_TOLERANCE = 1
const TAB_DRAG_THRESHOLD = 4

function tabScrollViewport(root: HTMLDivElement | null): HTMLDivElement | null {
  return root?.querySelector<HTMLDivElement>('[data-slot="scroll-area-viewport"]') ?? null
}

function chipsOf(root: HTMLDivElement | null): HTMLElement[] {
  return [...(root?.querySelectorAll<HTMLElement>('[data-tab-id]') ?? [])]
}

function revealActiveChip(viewport: HTMLDivElement | null): void {
  const active = viewport?.querySelector<HTMLElement>('[data-tab-id][data-active-tab="true"]')
  active?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
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
  onDragOut?: (id: string, start: { button: number; pointerId: number; clientX: number; clientY: number }) => void
}

const TAB_DRAG_OUT_PX = 12

function addMenuSections(actions: readonly LauncherAction[]): { reason: string | null; actions: LauncherAction[] }[] {
  const sections: { reason: string | null; actions: LauncherAction[] }[] = [{ reason: null, actions: [] }]
  for (const action of actions) {
    if (action.available) {
      sections[0].actions.push(action)
      continue
    }
    const reason = action.disabledReason ?? ''
    const section = sections.find((entry) => entry.reason === reason)
    if (section) section.actions.push(action)
    else sections.push({ reason, actions: [action] })
  }
  return sections.filter((section) => section.actions.length)
}

function AddSurfaceMenuAction(props: { action: LauncherAction }) {
  const { action } = props
  return (
    <MenuItem
      id={action.kind}
      textValue={action.label}
      icon={action.icon}
      isDisabled={!action.available}
      shortcut={<Kbd>{action.shortcut}</Kbd>}
      aria-keyshortcuts={action.shortcut}
      onAction={action.onPick}
    >
      {action.label}
    </MenuItem>
  )
}

export function TabStrip(props: TabStripProps) {
  const t = useOptionalT()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const stripRef = useRef<HTMLDivElement | null>(null)
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
      let width = viewport.clientWidth
      const observer = new ResizeObserver(() => {
        update()
        if (viewport.clientWidth === width) return
        width = viewport.clientWidth
        revealActiveChip(viewport)
      })
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
    revealActiveChip(tabScrollViewport(rootRef.current))
  }, [props.activeId, scroll.hasOverflow, props.tabs.length])

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

    const strip = (stripRef.current ?? rootRef.current)?.getBoundingClientRect() ?? null
    const handleMove = (moveEvent: globalThis.PointerEvent) => {
      if (
        props.onDragOut &&
        strip &&
        (moveEvent.clientY < strip.top - TAB_DRAG_OUT_PX ||
          moveEvent.clientY > strip.bottom + TAB_DRAG_OUT_PX ||
          moveEvent.clientX < strip.left - TAB_DRAG_OUT_PX ||
          moveEvent.clientX > strip.right + TAB_DRAG_OUT_PX)
      ) {
        stop()
        setDrag(null)
        props.onDragOut(surface.id, { button: 0, pointerId: moveEvent.pointerId, clientX: moveEvent.clientX, clientY: moveEvent.clientY })
        return
      }
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

  const handleAddMenuKeyDown = useEffectEvent((event: KeyboardEvent) => {
    const action = surfaceShortcutActionForKey(props.actions, event)
    if (!action) return
    event.preventDefault()
    event.stopPropagation()
    setAddMenuOpen(false)
    action.onPick()
  })

  useEffect(() => {
    if (!addMenuOpen) return undefined
    const handler = (event: KeyboardEvent) => handleAddMenuKeyDown(event)
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [addMenuOpen])

  return (
    <div ref={stripRef} className={cx('t3-tab-strip', props.className)}>
      <ScrollArea
        ref={attachTabList}
        hideScrollbars
        fade
        className="t3-tab-strip__scroll"
        data-right-panel-tab-list
      >
        <div className="t3-tab-strip__track">
          <div
            role="tablist"
            aria-label={props.listLabel ?? t('panel.t3.tabs')}
            className="t3-tab-strip__tabs"
            onKeyDown={onKeyDown}
          >
            {props.tabs.map((surface) => (
              <TabChip
                key={surface.id}
                surface={surface}
                active={surface.id === props.activeId}
                focusable={props.tabs.some((tab) => tab.id === props.activeId) ? surface.id === props.activeId : surface.id === props.tabs[0]?.id}
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
        </div>
      </ScrollArea>
      {scroll.hasOverflow ? (
        <MenuTrigger>
          <Button
            data-t3-btn
            variant="ghost"
            size="sm"
            aria-label={t('panel.t3.allTabs', { count: props.tabs.length })}
            tooltip={t('panel.t3.allTabs', { count: props.tabs.length })}
            trailingIcon={<ChevronDown className="t3-icon--xs" />}
            className="t3-tab-strip__all"
            data-testid="rp-all-tabs"
          >
            {props.tabs.length}
          </Button>
          <Popover placement="bottom end" offset={6}>
            <Menu
              autoFocus
              aria-label={t('panel.t3.allTabs', { count: props.tabs.length })}
              selectionMode="single"
              disallowEmptySelection
              selectedKeys={props.activeId ? [props.activeId] : []}
              onAction={(key) => props.onActivate(String(key))}
              className="t3-tab-strip__all-menu"
            >
              {props.tabs.map((surface) => (
                <MenuItem key={surface.id} id={surface.id} textValue={surface.label} checked="selection" icon={<SurfaceIcon surface={surface} />}>
                  {surface.label}
                </MenuItem>
              ))}
            </Menu>
          </Popover>
        </MenuTrigger>
      ) : null}
      {props.showAdd === false ? null : (
        <MenuTrigger isOpen={addMenuOpen} onOpenChange={setAddMenuOpen}>
          <IconButton data-t3-btn variant="ghost" size="md" aria-label={props.addLabel ?? t('panel.t3.addSurface')} className="t3-tab-strip__add" data-testid="rp-new-tab">
            <Plus className="t3-icon--sm" />
          </IconButton>
          <Popover placement="bottom start" offset={6}>
            <Menu autoFocus="first" className="t3-tab-strip__menu" aria-label={props.addLabel ?? t('panel.t3.addSurface')}>
              {addMenuSections(props.actions).map((section, index) =>
                section.reason === null ? (
                  section.actions.map((action) => <AddSurfaceMenuAction key={action.kind} action={action} />)
                ) : (
                  <MenuSection key={`off:${index}`} id={`off:${index}`} className="t3-tab-strip__off">
                    {section.reason ? <Header>{section.reason}</Header> : null}
                    {section.actions.map((action) => <AddSurfaceMenuAction key={action.kind} action={action} />)}
                  </MenuSection>
                )
              )}
            </Menu>
          </Popover>
        </MenuTrigger>
      )}
    </div>
  )
}
