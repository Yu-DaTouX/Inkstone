import {
  useEffect,
  useRef,
  useState,
  type Key,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement
} from 'react'
import { ChevronDown } from 'lucide-react'
import { IconButton, Menu, MenuItem, MenuSection, PanelTab, PanelTabList, Popover, Separator, SubmenuTrigger } from '../../ui'
import { previewTabDirectory, previewTabLabel } from '../workbench/preview-state'
import { previewTabKeyAction, previewTabMenu, type PreviewTabAction, type PreviewTabFileAction } from './preview-tab-menu'
import { TAB_DRAG_THRESHOLD, dropGapIndex, dropIndexFor, tabMoveKey } from './tab-reorder'
import { hiddenTabsAt, tabStripLayout, type TabSpan } from './preview-tab-strip'
import { FileTypeIcon } from '../../ui/FileTypeIcon'
import type { PreviewText } from './preview-text'

export interface PreviewTabsProps {
  tabs: readonly string[]
  active: string
  preview: string | null
  cwd: string
  chrome: boolean
  text: PreviewText
  onSelect: (path: string) => void
  onClose: (path: string) => void
  onKeep: (path: string) => void
  onCloseOthers: (path: string) => void
  onCloseRight: (path: string) => void
  onCloseAll: () => void
  onReorder?: (path: string, toIndex: number) => void
  onRevealInTree?: (path: string) => void
}

function measureTabSpans(strip: HTMLElement): TabSpan[] {
  const box = strip.getBoundingClientRect()
  const spans: TabSpan[] = []
  for (const node of strip.querySelectorAll<HTMLElement>('[data-tab-path]')) {
    const path = node.dataset.tabPath
    if (!path) continue
    const rect = node.getBoundingClientRect()
    const start = rect.left - box.left + strip.scrollLeft
    spans.push({ id: path, start, end: start + rect.width })
  }
  return spans
}

function sameIds(previous: readonly string[], next: readonly string[]): boolean {
  return previous.length === next.length && previous.every((value, index) => value === next[index])
}

function markTabStripEdges(strip: HTMLElement): void {
  const start = strip.scrollLeft > 2
  const end = strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 2
  strip.toggleAttribute('data-clip-start', start)
  strip.toggleAttribute('data-clip-end', end)
}

export function PreviewTabs({
  tabs,
  active,
  preview,
  cwd,
  chrome,
  text,
  onSelect,
  onClose,
  onKeep,
  onCloseOthers,
  onCloseRight,
  onCloseAll,
  onReorder,
  onRevealInTree
}: PreviewTabsProps): ReactElement {
  const stripRef = useRef<HTMLDivElement>(null)
  const anchorRef = useRef<HTMLElement | null>(null)
  const overflowRef = useRef<HTMLButtonElement | null>(null)
  const activeRef = useRef(active)
  activeRef.current = active
  const [hidden, setHidden] = useState<readonly string[]>([])
  const [overflowOpen, setOverflowOpen] = useState(false)
  const [menuPath, setMenuPath] = useState<string | null>(null)
  const [drag, setDrag] = useState<{ path: string; gap: number } | null>(null)
  const dragRef = useRef<{ path: string; from: number; to: number; startX: number; moved: boolean } | null>(null)
  const dragCleanupRef = useRef<(() => void) | null>(null)

  useEffect(() => () => dragCleanupRef.current?.(), [])

  useEffect(() => {
    const strip = stripRef.current
    if (!strip) return undefined
    const measure = (): void => {
      if (strip.clientWidth < 1) return
      const layout = tabStripLayout({
        tabs: measureTabSpans(strip),
        width: strip.clientWidth,
        scrollLeft: strip.scrollLeft,
        maxScroll: Math.max(0, strip.scrollWidth - strip.clientWidth),
        activeId: activeRef.current
      })
      if (Math.abs(strip.scrollLeft - layout.scrollLeft) > 0.5) strip.scrollLeft = layout.scrollLeft
      markTabStripEdges(strip)
      setHidden((previous) => (sameIds(previous, layout.hiddenIds) ? previous : layout.hiddenIds))
    }
    const onScroll = (): void => {
      markTabStripEdges(strip)
      const next = hiddenTabsAt(measureTabSpans(strip), strip.clientWidth, strip.scrollLeft, activeRef.current)
      setHidden((previous) => (sameIds(previous, next) ? previous : next))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(strip)
    for (const node of strip.querySelectorAll<HTMLElement>('.v3-preview-tab')) observer.observe(node)
    strip.addEventListener('scroll', onScroll)
    return () => {
      observer.disconnect()
      strip.removeEventListener('scroll', onScroll)
    }
  }, [active, tabs, chrome])

  useEffect(() => {
    if (!hidden.length) setOverflowOpen(false)
  }, [hidden.length])

  const openMenu = (path: string, anchor: HTMLElement): void => {
    anchorRef.current = anchor
    setMenuPath(path)
  }

  const closeMenu = (): void => {
    const anchor = anchorRef.current
    setMenuPath(null)
    requestAnimationFrame(() => {
      if (anchor?.isConnected) anchor.querySelector<HTMLElement>('[role="tab"]')?.focus()
    })
  }

  const model = menuPath
    ? previewTabMenu({ path: menuPath, cwd, tabs, preview: preview === menuPath, canRevealInTree: !!onRevealInTree })
    : null

  const runMenu = (key: Key): void => {
    const path = menuPath
    if (!path || !model) return
    const action = String(key) as PreviewTabAction | PreviewTabFileAction
    switch (action) {
      case 'copy:absolute':
        void navigator.clipboard.writeText(model.copy.absolute)
        break
      case 'copy:relative':
        if (model.copy.relative) void navigator.clipboard.writeText(model.copy.relative)
        break
      case 'copy:name':
        void navigator.clipboard.writeText(model.copy.name)
        break
      case 'reveal':
        void window.yan.revealPath(path)
        break
      case 'reveal-tree':
        onRevealInTree?.(path)
        break
      case 'keep':
        onKeep(path)
        break
      case 'close':
        onClose(path)
        break
      case 'close-others':
        onCloseOthers(path)
        break
      case 'close-right':
        onCloseRight(path)
        break
      case 'close-all':
        onCloseAll()
        break
    }
    closeMenu()
  }

  const tabLabel = (action: PreviewTabAction): string =>
    action === 'keep'
      ? text.keepTab
      : action === 'close'
        ? text.closeTab
        : action === 'close-others'
          ? text.closeOtherTabs
          : action === 'close-right'
            ? text.closeTabsRight
            : text.closeAllTabs

  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLElement>, path: string): void => {
    if ((event.target as HTMLElement).getAttribute('role') !== 'tab') return
    const move = tabMoveKey({ key: event.key, ctrl: event.ctrlKey, meta: event.metaKey, alt: event.altKey, shift: event.shiftKey })
    if (move && onReorder) {
      event.preventDefault()
      event.stopPropagation()
      const to = tabs.indexOf(path) + move
      if (to >= 0 && to < tabs.length) onReorder(path, to)
      return
    }
    const action = previewTabKeyAction(event.key, {
      ctrl: event.ctrlKey,
      shift: event.shiftKey,
      alt: event.altKey,
      meta: event.metaKey
    })
    if (action) return
    if (event.key === 'Delete' || event.key === 'Backspace' || event.key === 'ContextMenu' || event.key === 'F10') event.stopPropagation()
  }

  const startDrag = (event: ReactPointerEvent<HTMLElement>, path: string): void => {
    if (!onReorder || tabs.length < 2) return
    if (event.button !== 0 || event.isPrimary === false) return
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
    if ((event.target as HTMLElement).closest('[data-panel-tab-close], input, textarea')) return
    const strip = stripRef.current
    if (!strip) return
    const from = tabs.indexOf(path)
    if (from < 0) return
    const state = { path, from, to: from, startX: event.clientX, moved: false }
    dragRef.current = state
    const centres = (): number[] =>
      [...strip.querySelectorAll<HTMLElement>('.v3-preview-tab')]
        .map((node, index) => ({ node, index }))
        .filter((item) => item.index !== from)
        .map((item) => {
          const box = item.node.getBoundingClientRect()
          return box.left + box.width / 2
        })
    const move = (moveEvent: PointerEvent): void => {
      if (moveEvent.buttons === 0) {
        finish(true)
        return
      }
      if (!state.moved) {
        if (Math.abs(moveEvent.clientX - state.startX) < TAB_DRAG_THRESHOLD) return
        state.moved = true
      }
      const box = strip.getBoundingClientRect()
      const centre = Math.min(Math.max(moveEvent.clientX, box.left + 2), box.right - 2)
      state.to = dropIndexFor(centres(), centre)
      const gap = state.to === state.from ? -1 : dropGapIndex(state.to, state.from)
      setDrag((previous) => (previous?.path === path && previous.gap === gap ? previous : { path, gap }))
    }
    const swallow = (click: Event): void => {
      click.preventDefault()
      click.stopPropagation()
      cleanup()
    }
    const settle = (): void => cleanup()
    const cleanup = (): void => {
      document.removeEventListener('click', swallow, true)
      document.removeEventListener('pointerdown', settle, true)
      document.removeEventListener('keydown', settle, true)
      window.clearTimeout(timer)
      dragCleanupRef.current = null
    }
    let timer = 0
    const detach = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', key)
      window.removeEventListener('blur', blur)
    }
    const teardown = (): void => {
      detach()
      cleanup()
    }
    dragCleanupRef.current = teardown
    const finish = (commit: boolean): void => {
      detach()
      dragRef.current = null
      setDrag(null)
      if (!state.moved) {
        teardown()
        return
      }
      document.addEventListener('click', swallow, true)
      document.addEventListener('pointerdown', settle, true)
      document.addEventListener('keydown', settle, true)
      timer = window.setTimeout(cleanup, 400)
      if (commit && state.to !== state.from) onReorder?.(state.path, state.to)
    }
    const up = (): void => finish(true)
    const cancel = (): void => finish(false)
    const blur = (): void => finish(false)
    const key = (pressed: KeyboardEvent): void => {
      if (pressed.key !== 'Escape') return
      pressed.preventDefault()
      pressed.stopPropagation()
      finish(false)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('keydown', key, true)
    window.addEventListener('blur', blur)
  }

  return (
    <>
      <div className={chrome ? 'v3-preview-tabbar v3-preview-tabbar--chrome' : 'v3-preview-tabbar'}>
        <div className="v3-preview-tabstrip" data-testid="v3-preview-tabs">
          <PanelTabList
            ref={stripRef}
            label={text.tabsLabel}
            onCloseFocused={onClose}
            onContextMenuFocused={(path, anchor) => openMenu(path, anchor)}
          >
            {tabs.map((tab, index) => {
              const label = previewTabLabel(tab)
              const isPreview = preview === tab
              const isHidden = hidden.includes(tab)
              const directory = previewTabDirectory(tab, cwd)
              const gap = drag?.gap ?? -1
              return (
                <PanelTab
                  key={tab}
                  id={tab}
                  className="v3-preview-tab"
                  label={label}
                  title={directory ? `${label}\n${directory}` : label}
                  icon={<FileTypeIcon name={label} size={14} />}
                  active={tab === active}
                  preview={isPreview}
                  description={isPreview ? text.previewTabHint : undefined}
                  closeLabel={`${text.closeTab}: ${label}`}
                  testId={`v3-preview-tab-${label}`}
                  data-tab-path={tab}
                  data-overflowed={isHidden ? '' : undefined}
                  data-menu-open={menuPath === tab ? '' : undefined}
                  data-dragging={drag?.path === tab ? '' : undefined}
                  data-drop-before={gap === index ? '' : undefined}
                  data-drop-after={gap === tabs.length && index === tabs.length - 1 ? '' : undefined}
                  onPointerDown={(event) => startDrag(event, tab)}
                  onKeyDown={(event) => onTabKeyDown(event, tab)}
                  onDoubleClick={isPreview && !isHidden ? () => onKeep(tab) : undefined}
                  onSelect={() => onSelect(tab)}
                  onClose={() => onClose(tab)}
                  onContextMenu={(event) => {
                    if (isHidden) return
                    event.preventDefault()
                    openMenu(tab, event.currentTarget)
                  }}
                />
              )
            })}
          </PanelTabList>
        </div>
        {hidden.length ? (
          <IconButton
            ref={overflowRef}
            size="sm"
            aria-label={text.moreTabs}
            tooltip={text.moreTabs}
            aria-haspopup="menu"
            data-testid="v3-preview-tab-overflow"
            onPress={() => setOverflowOpen(true)}
          >
            <ChevronDown size={14} />
          </IconButton>
        ) : null}
      </div>
      {hidden.length && overflowOpen ? (
        <Popover
          triggerRef={overflowRef}
          isOpen
          onOpenChange={(open) => {
            if (!open) setOverflowOpen(false)
          }}
          placement="bottom end"
          offset={4}
        >
          <Menu
            aria-label={text.moreTabs}
            autoFocus="first"
            onAction={(key) => {
              setOverflowOpen(false)
              onSelect(String(key))
            }}
            data-testid="v3-preview-tab-overflow-menu"
          >
            {tabs
              .filter((tab) => hidden.includes(tab))
              .map((tab) => (
                <MenuItem key={tab} id={tab} textValue={previewTabLabel(tab)}>
                  <span className="v3-preview-tab-overflow-item">
                    <span className="v3-preview-tab-overflow-name">{previewTabLabel(tab)}</span>
                    {previewTabDirectory(tab, cwd) ? (
                      <span className="v3-preview-tab-overflow-detail">{previewTabDirectory(tab, cwd)}</span>
                    ) : null}
                  </span>
                </MenuItem>
              ))}
          </Menu>
        </Popover>
      ) : null}
      {model && menuPath ? (
        <Popover
          triggerRef={anchorRef}
          isOpen
          onOpenChange={(open) => {
            if (!open) closeMenu()
          }}
          placement="bottom start"
          offset={4}
        >
          <Menu aria-label={previewTabLabel(menuPath)} autoFocus="first" onAction={runMenu} data-testid="v3-preview-tab-menu">
            <MenuSection aria-label={text.copy}>
              <SubmenuTrigger>
                <MenuItem id="copy" textValue={text.copy}>
                  {text.copy}
                </MenuItem>
                <Popover placement="end top" offset={2}>
                  <Menu aria-label={text.copy} onAction={runMenu} data-testid="v3-preview-tab-menu-copy">
                    <MenuItem id="copy:absolute" textValue={text.copyAbsolute}>
                      {text.copyAbsolute}
                    </MenuItem>
                    {model.copy.relative ? (
                      <MenuItem id="copy:relative" textValue={text.copyRelative}>
                        {text.copyRelative}
                      </MenuItem>
                    ) : null}
                    <MenuItem id="copy:name" textValue={text.copyName}>
                      {text.copyName}
                    </MenuItem>
                  </Menu>
                </Popover>
              </SubmenuTrigger>
              <MenuItem id="reveal" textValue={text.reveal}>
                {text.reveal}
              </MenuItem>
              {model.revealInTree ? (
                <MenuItem id="reveal-tree" textValue={text.revealInTree}>
                  {text.revealInTree}
                </MenuItem>
              ) : null}
            </MenuSection>
            <Separator />
            <MenuSection aria-label={text.tabsLabel}>
              {model.tabActions.map((action) => (
                <MenuItem key={action} id={action} textValue={tabLabel(action)}>
                  {tabLabel(action)}
                </MenuItem>
              ))}
            </MenuSection>
          </Menu>
        </Popover>
      ) : null}
    </>
  )
}
