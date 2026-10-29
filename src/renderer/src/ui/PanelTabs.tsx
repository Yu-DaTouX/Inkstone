import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode, Ref } from 'react'
import { X } from 'lucide-react'
import { cx } from './cx'
import './PanelTabs.css'

export interface PanelTabCloseButtonProps {
  label: string
  onClose: () => void
  children?: ReactNode
}

export function PanelTabCloseButton({ label, onClose, children }: PanelTabCloseButtonProps) {
  return (
    <button
      type="button"
      tabIndex={-1}
      className="ui-ptab__close"
      aria-label={label}
      title={label}
      data-panel-tab-close
      onClick={(event) => {
        event.stopPropagation()
        onClose()
      }}
    >
      {children ? <span className="ui-ptab__glyph" aria-hidden>{children}</span> : null}
      <X className="ui-ptab__x" size={12} aria-hidden />
    </button>
  )
}

export interface PanelTabProps {
  id: string
  label: string
  title?: string
  icon?: ReactNode
  active: boolean
  controls?: string
  closeLabel: string
  pending?: boolean
  testId?: string
  tabRef?: Ref<HTMLButtonElement>
  onSelect: () => void
  onClose: () => void
  onContextMenu?: (event: ReactMouseEvent<HTMLElement>) => void
}

export function PanelTab({ id, label, title, icon, active, controls, closeLabel, pending, testId, tabRef, onSelect, onClose, onContextMenu }: PanelTabProps) {
  return (
    <div
      role="presentation"
      className="ui-ptab"
      data-active={active ? '1' : undefined}
      data-panel-tab={id}
      data-testid={testId}
      onMouseDown={(event) => {
        if (event.button === 1) event.preventDefault()
      }}
      onAuxClick={(event) => {
        if (event.button !== 1) return
        event.preventDefault()
        onClose()
      }}
      onContextMenu={onContextMenu}
    >
      <PanelTabCloseButton label={closeLabel} onClose={onClose}>
        {icon}
        {pending ? <span className="ui-ptab__pending" /> : null}
      </PanelTabCloseButton>
      <button
        ref={tabRef}
        type="button"
        role="tab"
        id={`ptab-${id}`}
        className="ui-ptab__label"
        aria-selected={active}
        aria-controls={controls}
        tabIndex={active ? 0 : -1}
        title={title ?? label}
        onClick={onSelect}
      >
        <span className="ui-ptab__text">{label}</span>
      </button>
    </div>
  )
}

export interface PanelTabListProps {
  label: string
  className?: string
  children: ReactNode
  onCloseFocused?: (id: string) => void
  onContextMenuFocused?: (id: string, anchor: HTMLElement) => void
}

function tabsOf(list: HTMLElement): HTMLButtonElement[] {
  return [...list.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
}

export function PanelTabList({ label, className, children, onCloseFocused, onContextMenuFocused }: PanelTabListProps) {
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement
    if (target.getAttribute('role') !== 'tab') return
    const tabs = tabsOf(event.currentTarget)
    const index = tabs.indexOf(target as HTMLButtonElement)
    if (index < 0) return
    const host = target.closest<HTMLElement>('[data-panel-tab]')
    const id = host?.dataset.panelTab ?? ''
    let next: HTMLButtonElement | undefined
    if (event.key === 'ArrowRight') next = tabs[(index + 1) % tabs.length]
    else if (event.key === 'ArrowLeft') next = tabs[(index - 1 + tabs.length) % tabs.length]
    else if (event.key === 'Home') next = tabs[0]
    else if (event.key === 'End') next = tabs[tabs.length - 1]
    else if ((event.key === 'Delete' || event.key === 'Backspace') && id && onCloseFocused) {
      event.preventDefault()
      const neighbor = tabs[index + 1] ?? tabs[index - 1]
      onCloseFocused(id)
      requestAnimationFrame(() => neighbor?.focus())
      return
    } else if (((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu') && id && host && onContextMenuFocused) {
      event.preventDefault()
      onContextMenuFocused(id, host)
      return
    }
    if (!next) return
    event.preventDefault()
    next.focus()
    next.click()
  }
  return (
    <div
      role="tablist"
      aria-label={label}
      aria-orientation="horizontal"
      className={cx('ui-ptabs', className)}
      onKeyDown={onKeyDown}
      onWheel={(event) => {
        const list = event.currentTarget
        if (event.ctrlKey || list.scrollWidth <= list.clientWidth) return
        const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
        list.scrollLeft += delta
      }}
    >
      {children}
    </div>
  )
}
