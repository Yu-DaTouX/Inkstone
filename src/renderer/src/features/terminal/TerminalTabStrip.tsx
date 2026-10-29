import { useEffect, useRef, useState, type JSX } from 'react'
import { Plus, SquareTerminal } from 'lucide-react'
import { IconButton, Menu, MenuItem, PanelTab, PanelTabList, Popover } from '../../ui'
import { nextTerminalTabIndex } from './terminal-tabs'
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
  inline?: boolean
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
  inline = false,
  text,
  onSelect,
  onClose,
  onCloseOthers,
  onNew
}: TerminalTabStripProps): JSX.Element {
  const stripRef = useRef<HTMLDivElement | null>(null)
  const menuAnchor = useRef<HTMLElement | null>(null)
  const [menuKey, setMenuKey] = useState<string | null>(null)
  const keyboardMove = useRef(false)

  useEffect(() => {
    if (!active) return
    const node = stripRef.current?.querySelector<HTMLElement>(`[data-panel-tab="${CSS.escape(active)}"]`)
    node?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active, tabs.length])

  const selectTab = (key: string): void => {
    const fromKeyboard = keyboardMove.current
    keyboardMove.current = false
    onSelect(key)
    if (!fromKeyboard) return
    requestAnimationFrame(() => {
      stripRef.current?.querySelector<HTMLElement>(`[data-panel-tab="${CSS.escape(key)}"] [role="tab"]`)?.focus()
    })
  }

  const openTabMenu = (key: string, anchor: HTMLElement): void => {
    menuAnchor.current = anchor
    setMenuKey(key)
  }

  const closeMenu = (): void => {
    const anchor = menuAnchor.current
    setMenuKey(null)
    requestAnimationFrame(() => {
      if (anchor?.isConnected) anchor.querySelector<HTMLElement>('[role="tab"]')?.focus()
    })
  }

  return (
    <div className="term-tabbar" data-inline={inline ? '' : undefined}>
      <PanelTabList
        ref={stripRef}
        label={text.tabs}
        className="term-tabs"
        data-testid="terminal-tabs"
        onKeyDownCapture={(event) => {
          keyboardMove.current = nextTerminalTabIndex(0, 2, event.key) !== null
        }}
        onCloseFocused={onClose}
        onContextMenuFocused={openTabMenu}
      >
          {tabs.map((tab) => (
            <PanelTab
              key={tab.key}
              id={tab.key}
              label={tab.label}
              title={tab.detail || tab.label}
              icon={<SquareTerminal aria-hidden />}
              active={tab.key === active}
              pending={tab.busy}
              muted={tab.exited}
              attention={bell === tab.key}
              closeLabel={text.closeTab}
              testId={`terminal-tab-${tab.key}`}
              onSelect={() => selectTab(tab.key)}
              onClose={() => onClose(tab.key)}
              onContextMenu={(event) => {
                event.preventDefault()
                openTabMenu(tab.key, event.currentTarget)
              }}
            />
          ))}
      </PanelTabList>
      <IconButton
        size="sm"
        className="term-tab-new"
        aria-label={text.newTab}
        tooltip={text.newTab}
        isDisabled={!canAdd}
        onPress={onNew}
        data-testid="terminal-new"
      >
        <Plus size={14} aria-hidden />
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
