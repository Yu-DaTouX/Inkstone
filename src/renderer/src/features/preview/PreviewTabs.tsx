import { useEffect, useRef, useState, type Key, type KeyboardEvent, type MouseEvent, type ReactElement } from 'react'
import { X } from 'lucide-react'
import { Menu, MenuItem, MenuSection, Popover, Separator, SubmenuTrigger } from '../../ui'
import { FileTypeIcon } from '../../ui/FileTypeIcon'
import { previewTabDetail, previewTabLabel } from '../workbench/preview-state'
import { previewTabKeyAction, previewTabMenu, type PreviewTabAction, type PreviewTabFileAction } from './preview-tab-menu'
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
  onRevealInTree?: (path: string) => void
}

function revealActiveTab(strip: HTMLElement): void {
  const active = strip.querySelector<HTMLElement>('.v3-preview-tab.is-active')
  if (active) {
    const box = strip.getBoundingClientRect()
    const tab = active.getBoundingClientRect()
    if (tab.left < box.left) strip.scrollLeft -= box.left - tab.left
    else if (tab.right > box.right) strip.scrollLeft += tab.right - box.right
  }
  markTabStripEdges(strip)
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
  onRevealInTree
}: PreviewTabsProps): ReactElement {
  const stripRef = useRef<HTMLDivElement>(null)
  const anchorRef = useRef<HTMLElement | null>(null)
  const [menuPath, setMenuPath] = useState<string | null>(null)

  useEffect(() => {
    const strip = stripRef.current
    if (!strip) return undefined
    revealActiveTab(strip)
    const observer = new ResizeObserver(() => revealActiveTab(strip))
    observer.observe(strip)
    return () => observer.disconnect()
  }, [active, tabs.length, chrome])

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

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, path: string): void => {
    const action = previewTabKeyAction(event.key, {
      ctrl: event.ctrlKey,
      shift: event.shiftKey,
      alt: event.altKey,
      meta: event.metaKey
    })
    if (!action) return
    event.preventDefault()
    if (action === 'close') onClose(path)
    else {
      const host = event.currentTarget.closest<HTMLElement>('.v3-preview-tab')
      if (host) openMenu(path, host)
    }
  }

  return (
    <>
      <div
        ref={stripRef}
        className={chrome ? 'v3-preview-tabstrip v3-preview-tabstrip--chrome' : 'v3-preview-tabstrip'}
        role="tablist"
        aria-label={text.tabsLabel}
        data-testid="v3-preview-tabs"
        onWheel={(event) => {
          if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) event.currentTarget.scrollLeft += event.deltaY
        }}
        onScroll={(event) => markTabStripEdges(event.currentTarget)}
      >
        {tabs.map((tab) => {
          const label = previewTabLabel(tab)
          const isPreview = preview === tab
          return (
            <span
              key={tab}
              className={`v3-preview-tab${tab === active ? ' is-active' : ''}`}
              data-preview={isPreview ? '' : undefined}
              data-menu-open={menuPath === tab ? '' : undefined}
              data-testid={`v3-preview-tab-${label}`}
              onMouseDown={(event: MouseEvent) => {
                if (event.button === 1) event.preventDefault()
              }}
              onAuxClick={(event: MouseEvent) => {
                if (event.button !== 1) return
                event.preventDefault()
                onClose(tab)
              }}
              onDoubleClick={isPreview ? () => onKeep(tab) : undefined}
              onContextMenu={(event: MouseEvent<HTMLSpanElement>) => {
                event.preventDefault()
                openMenu(tab, event.currentTarget)
              }}
            >
              <FileTypeIcon name={label} size={14} className="v3-preview-tab-ico" />
              <button
                type="button"
                role="tab"
                aria-selected={tab === active}
                className="v3-preview-tab-name"
                title={previewTabDetail(tab, cwd)}
                onClick={() => onSelect(tab)}
                onKeyDown={(event) => onTabKeyDown(event, tab)}
              >
                {label}
                {isPreview ? <span className="v3-preview-sr">{`, ${text.previewTabHint}`}</span> : null}
              </button>
              <button
                type="button"
                tabIndex={-1}
                className="v3-preview-tab-close"
                aria-label={`${text.closeTab}: ${label}`}
                title={text.closeTab}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onClose(tab)}
              >
                <X size={11} />
              </button>
            </span>
          )
        })}
      </div>
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
