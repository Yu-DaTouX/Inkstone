import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent } from 'react'
import { Bot, ChevronDown, Plus, SquareTerminal } from '../../ui/icons'
import { IconButton, Menu, MenuItem, PanelTab, PanelTabList, Popover, StatusDot } from '../../ui'
import { useT } from '../../i18n'
import { nextTerminalTabIndex, terminalTabWindow, type TerminalTabWindow } from './terminal-tabs'
import type { TerminalText } from './terminal-text'
import type { DragStart } from '../sidebar/session-drag'

const DRAG_OUT_PX = 12

export interface TerminalTabItem {
  key: string
  label: string
  detail: string
  busy: boolean
  exited: boolean
  agent?: boolean
  agentOwned?: boolean
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
  onNew?: () => void
  onDragOut?: (key: string, start: DragStart) => void
}

function sameIds(previous: readonly string[], next: readonly string[]): boolean {
  return previous.length === next.length && previous.every((value, index) => value === next[index])
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
  onNew,
  onDragOut
}: TerminalTabStripProps): JSX.Element {
  const t = useT()
  const barRef = useRef<HTMLDivElement | null>(null)
  const stripRef = useRef<HTMLDivElement | null>(null)
  const menuAnchor = useRef<HTMLElement | null>(null)
  const [menuKey, setMenuKey] = useState<string | null>(null)
  const overflowRef = useRef<HTMLButtonElement | null>(null)
  const startRef = useRef(0)
  const [view, setView] = useState<TerminalTabWindow | null>(null)
  const [overflowOpen, setOverflowOpen] = useState(false)
  const keyboardMove = useRef(false)
  const tabKeys = tabs.map((tab) => tab.key).join('\n')
  const hidden = useMemo<readonly string[]>(
    () => (view ? tabKeys.split('\n').filter((_, index) => index < view.start || index >= view.start + view.count) : []),
    [tabKeys, view]
  )
  const shown = view ? tabs.slice(view.start, view.start + view.count) : tabs

  useLayoutEffect(() => {
    const bar = barRef.current
    const strip = stripRef.current
    if (!bar || !strip) return undefined
    const measure = (): void => {
      if (bar.clientWidth < 1) return
      const bounds = getComputedStyle(bar)
      const gap = parseFloat(bounds.columnGap) || 0
      const inner = bar.clientWidth - (parseFloat(bounds.paddingLeft) || 0) - (parseFloat(bounds.paddingRight) || 0)
      const add = bar.querySelector<HTMLElement>('.term-tab-new')
      const button = add?.getBoundingClientRect().width || 24
      const tab = strip.querySelector<HTMLElement>('.ui-ptab')
      const next = terminalTabWindow({
        total: tabs.length,
        active: Math.max(0, tabs.findIndex((item) => item.key === active)),
        start: startRef.current,
        width: inner - (add ? button + gap : 0),
        tabMin: (tab && parseFloat(getComputedStyle(tab).minWidth)) || 55,
        gap: parseFloat(getComputedStyle(strip).columnGap) || 0,
        button: button + gap
      })
      if (next) startRef.current = next.start
      setView((previous) => (previous?.start === next?.start && previous?.count === next?.count ? previous : next))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(bar)
    return () => observer.disconnect()
  }, [tabKeys, active, !!onNew])

  useEffect(() => {
    if (!hidden.length) setOverflowOpen(false)
  }, [hidden.length])

  const [missed, setMissed] = useState<readonly string[]>([])
  useEffect(() => {
    const keys = tabKeys.split('\n')
    setMissed((previous) => {
      let next = previous.filter((key) => key !== active && keys.includes(key))
      if (bell && bell !== active && hidden.includes(bell) && !next.includes(bell)) next = [...next, bell]
      return sameIds(previous, next) ? previous : next
    })
  }, [bell, hidden, active, tabKeys])

  const flagged = (key: string): boolean => bell === key || missed.includes(key)
  const hiddenFlagged = hidden.some(flagged)
  const overflowLabel = hiddenFlagged ? `${text.moreTabs(hidden.length)} · ${t('term.tabBell')}` : text.moreTabs(hidden.length)

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

  const watchDragOut = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!onDragOut || event.button !== 0 || !(event.target instanceof Element)) return
    if (event.target.closest('.ui-ptab__close')) return
    const key = event.target.closest<HTMLElement>('[data-panel-tab]')?.dataset.panelTab
    const box = stripRef.current?.getBoundingClientRect()
    if (!key || !box) return
    const pointerId = event.pointerId
    const stop = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
    }
    const move = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return
      if (ev.buttons === 0) {
        stop()
        return
      }
      if (ev.clientY >= box.top - DRAG_OUT_PX && ev.clientY <= box.bottom + DRAG_OUT_PX) return
      stop()
      onDragOut(key, { button: 0, pointerId, clientX: ev.clientX, clientY: ev.clientY })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
  }

  const closeMenu = (): void => {
    const anchor = menuAnchor.current
    setMenuKey(null)
    requestAnimationFrame(() => {
      if (anchor?.isConnected) anchor.querySelector<HTMLElement>('[role="tab"]')?.focus()
    })
  }

  return (
    <div ref={barRef} className="term-tabbar" data-inline={inline ? '' : undefined} onPointerDownCapture={watchDragOut}>
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
          {shown.map((tab) => (
            <PanelTab
              key={tab.key}
              id={tab.key}
              label={tab.label}
              title={[tab.agentOwned ? text.agentTab : '', tab.detail || tab.label].filter(Boolean).join('\n')}
              icon={tab.agentOwned ? <Bot aria-hidden /> : <SquareTerminal aria-hidden />}
              description={tab.agentOwned ? text.agentTab : undefined}
              data-agent={tab.agentOwned ? '1' : undefined}
              active={tab.key === active}
              pending={tab.busy || !!tab.agent}
              muted={tab.exited}
              attention={flagged(tab.key)}
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
      {hidden.length ? (
        <IconButton
          ref={overflowRef}
          size="sm"
          className="term-tab-more"
          aria-label={overflowLabel}
          tooltip={overflowLabel}
          aria-haspopup="menu"
          onPress={() => setOverflowOpen(true)}
          data-testid="terminal-tab-overflow"
          data-attention={hiddenFlagged ? '' : undefined}
        >
          <ChevronDown size={14} aria-hidden />
          {hiddenFlagged ? <StatusDot kind="awaiting" className="term-tab-more__dot" /> : null}
        </IconButton>
      ) : null}
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
            aria-label={text.moreTabs(hidden.length)}
            autoFocus="first"
            onAction={(key) => {
              setOverflowOpen(false)
              onSelect(String(key))
            }}
            data-testid="terminal-tab-overflow-menu"
          >
            {tabs
              .filter((tab) => hidden.includes(tab.key))
              .map((tab) => (
                <MenuItem
                  key={tab.key}
                  id={tab.key}
                  textValue={tab.label}
                  aria-label={
                    [tab.label, tab.agentOwned ? text.agentTab : '', flagged(tab.key) ? t('term.tabBell') : tab.exited ? t('term.tabExited') : '']
                      .filter(Boolean)
                      .join(' · ')
                  }
                  icon={tab.agentOwned ? <Bot size={14} aria-hidden /> : <SquareTerminal size={14} aria-hidden />}
                  trailingValue={
                    flagged(tab.key) ? (
                      <StatusDot kind="awaiting" />
                    ) : tab.exited ? (
                      <StatusDot kind="idle" />
                    ) : undefined
                  }
                  data-attention={flagged(tab.key) ? '' : undefined}
                  data-exited={tab.exited ? '' : undefined}
                >
                  {tab.label}
                </MenuItem>
              ))}
          </Menu>
        </Popover>
      ) : null}
      {onNew ? (
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
      ) : null}
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
