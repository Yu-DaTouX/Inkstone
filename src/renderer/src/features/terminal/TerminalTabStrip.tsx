import { useEffect, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent } from 'react'
import { Bot, ChevronDown, Plus, SquareTerminal } from '../../ui/icons'
import { IconButton, Menu, MenuItem, PanelTab, PanelTabList, Popover, StatusDot } from '../../ui'
import { useT } from '../../i18n'
import { hiddenTabsAt, tabStripLayout, type TabSpan } from '../preview/preview-tab-strip'
import { nextTerminalTabIndex } from './terminal-tabs'
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

function measureTabSpans(strip: HTMLElement): TabSpan[] {
  const box = strip.getBoundingClientRect()
  const spans: TabSpan[] = []
  for (const node of strip.querySelectorAll<HTMLElement>('[data-panel-tab]')) {
    const id = node.dataset.panelTab
    if (!id) continue
    const rect = node.getBoundingClientRect()
    const start = rect.left - box.left + strip.scrollLeft
    spans.push({ id, start, end: start + rect.width })
  }
  return spans
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
  const stripRef = useRef<HTMLDivElement | null>(null)
  const menuAnchor = useRef<HTMLElement | null>(null)
  const [menuKey, setMenuKey] = useState<string | null>(null)
  const overflowRef = useRef<HTMLButtonElement | null>(null)
  const activeRef = useRef(active)
  activeRef.current = active
  const [hidden, setHidden] = useState<readonly string[]>([])
  const [overflowOpen, setOverflowOpen] = useState(false)
  const keyboardMove = useRef(false)
  const labelKey = tabs.map((tab) => `${tab.key}:${tab.label}`).join('\n')

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
      setHidden((previous) => (sameIds(previous, layout.hiddenIds) ? previous : layout.hiddenIds))
    }
    const onScroll = (): void => {
      const next = hiddenTabsAt(measureTabSpans(strip), strip.clientWidth, strip.scrollLeft, activeRef.current)
      setHidden((previous) => (sameIds(previous, next) ? previous : next))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(strip)
    for (const node of strip.querySelectorAll<HTMLElement>('[data-panel-tab]')) observer.observe(node)
    strip.addEventListener('scroll', onScroll)
    return () => {
      observer.disconnect()
      strip.removeEventListener('scroll', onScroll)
    }
  }, [active, labelKey])

  useEffect(() => {
    if (!hidden.length) setOverflowOpen(false)
  }, [hidden.length])

  const [missed, setMissed] = useState<readonly string[]>([])
  const tabKeys = tabs.map((tab) => tab.key).join('\n')
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
    <div className="term-tabbar" data-inline={inline ? '' : undefined} onPointerDownCapture={watchDragOut}>
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
              title={[tab.agentOwned ? text.agentTab : '', tab.detail || tab.label].filter(Boolean).join('\n')}
              icon={tab.agentOwned ? <Bot aria-hidden /> : <SquareTerminal aria-hidden />}
              description={tab.agentOwned ? text.agentTab : undefined}
              data-agent={tab.agentOwned ? '1' : undefined}
              data-overflowed={tab.key !== active && hidden.includes(tab.key) ? '' : undefined}
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
