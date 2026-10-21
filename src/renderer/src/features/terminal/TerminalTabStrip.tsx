import { useEffect, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { Plus, X } from 'lucide-react'
import { IconButton, Menu, MenuItem, Popover } from '../../ui'
import { isTerminalTabCloseKey, nextTerminalTabIndex } from './terminal-tabs'
import type { TerminalText } from './terminal-text'

export interface TerminalTabItem {
  key: string
  label: string
  detail: string
  busy: boolean
  exited: boolean
}

export interface TerminalTabStripProps {
  tabs: readonly TerminalTabItem[]
  active: string | null
  bell: string | null
  canAdd: boolean
  text: TerminalText
  onSelect: (key: string) => void
  onClose: (key: string) => void
  onCloseOthers: (key: string) => void
  onNew: () => void
}

export function TerminalTabStrip({
  tabs,
  active,
  bell,
  canAdd,
  text,
  onSelect,
  onClose,
  onCloseOthers,
  onNew
}: TerminalTabStripProps): JSX.Element {
  const stripRef = useRef<HTMLDivElement | null>(null)
  const menuAnchor = useRef<HTMLElement | null>(null)
  const [menuKey, setMenuKey] = useState<string | null>(null)

  useEffect(() => {
    const strip = stripRef.current
    if (!strip || !active) return
    const node = strip.querySelector<HTMLElement>(`[data-term-tab="${active}"]`)
    if (!node) return
    const box = strip.getBoundingClientRect()
    const tab = node.getBoundingClientRect()
    if (tab.left < box.left) strip.scrollLeft -= box.left - tab.left
    else if (tab.right > box.right) strip.scrollLeft += tab.right - box.right
  }, [active, tabs.length])

  const focusTab = (key: string): void => {
    requestAnimationFrame(() => {
      stripRef.current?.querySelector<HTMLElement>(`[data-term-tab="${key}"] [role="tab"]`)?.focus()
    })
  }

  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, key: string): void => {
    const index = tabs.findIndex((tab) => tab.key === key)
    if (index < 0) return
    if (isTerminalTabCloseKey({ key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey })) {
      event.preventDefault()
      onClose(key)
      return
    }
    const next = nextTerminalTabIndex(index, tabs.length, event.key)
    if (next === null || tabs[next] === undefined) return
    event.preventDefault()
    onSelect(tabs[next].key)
    focusTab(tabs[next].key)
  }

  const openTabMenu = (key: string, anchor: HTMLElement): void => {
    menuAnchor.current = anchor
    setMenuKey(key)
  }

  const closeTabMenu = (): void => {
    const anchor = menuAnchor.current
    setMenuKey(null)
    requestAnimationFrame(() => {
      if (anchor?.isConnected) anchor.querySelector<HTMLElement>('[role="tab"]')?.focus()
    })
  }

  const closeMenu = (): void => {
    closeTabMenu()
  }

  const selectTab = (key: string): void => {
    onSelect(key)
  }

  return (
    <div className="term-tabbar">
      <div className="term-tabs" role="tablist" aria-label={text.tabs} ref={stripRef} data-testid="terminal-tabs">
        {tabs.map((tab) => (
          <div
            key={tab.key}
            role="presentation"
            className="term-tab"
            data-term-tab={tab.key}
            data-selected={tab.key === active ? '' : undefined}
            data-busy={tab.busy ? '' : undefined}
            data-exited={tab.exited ? '' : undefined}
            data-bell={bell === tab.key ? '' : undefined}
            data-menu-open={menuKey === tab.key ? '' : undefined}
            onMouseDown={(event: ReactMouseEvent) => {
              if (event.button === 1) event.preventDefault()
            }}
            onAuxClick={(event: ReactMouseEvent) => {
              if (event.button !== 1) return
              event.preventDefault()
              onClose(tab.key)
            }}
            onContextMenu={(event: ReactMouseEvent<HTMLDivElement>) => {
              event.preventDefault()
              openTabMenu(tab.key, event.currentTarget)
            }}
          >
            <span className="term-tab-bg" aria-hidden />
            <button
              type="button"
              role="tab"
              aria-selected={tab.key === active}
              tabIndex={tab.key === active ? 0 : -1}
              className="term-tab-name"
              title={tab.detail || tab.label}
              onClick={() => selectTab(tab.key)}
              onKeyDown={(event) => onTabKeyDown(event, tab.key)}
            >
              {tab.busy ? <span className="term-tab-dot" aria-hidden /> : null}
              <span className="term-tab-label">{tab.label}</span>
            </button>
            <button
              type="button"
              tabIndex={-1}
              className="term-tab-close"
              aria-label={text.closeTab}
              title={text.closeTab}
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.stopPropagation()
                onClose(tab.key)
              }}
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
      <IconButton
        size="sm"
        className="term-tab-new"
        aria-label={text.newTab}
        title={text.newTab}
        isDisabled={!canAdd}
        onPress={onNew}
        data-testid="terminal-new"
      >
        <Plus size={14} strokeWidth={1.75} />
      </IconButton>
      {menuKey && tabs.some((tab) => tab.key === menuKey) ? (
        <Popover
          triggerRef={menuAnchor}
          isOpen
          onOpenChange={(open) => {
            if (!open) closeMenu()
          }}
          placement="bottom start"
          offset={4}
        >
          <Menu
            aria-label={text.tabMenu}
            autoFocus="first"
            onAction={(key) => {
              const id = String(key)
              if (id === 'close') onClose(menuKey)
              else if (id === 'close-others') onCloseOthers(menuKey)
              closeMenu()
            }}
          >
            <MenuItem id="close" textValue={text.closeTab}>
              {text.closeTab}
            </MenuItem>
            {tabs.length > 1 ? (
              <MenuItem id="close-others" textValue={text.closeOthers}>
                {text.closeOthers}
              </MenuItem>
            ) : null}
          </Menu>
        </Popover>
      ) : null}
    </div>
  )
}
