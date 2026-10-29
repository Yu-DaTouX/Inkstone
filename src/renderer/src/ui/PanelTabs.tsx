import {
  forwardRef,
  useId,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref
} from 'react'
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
  muted?: boolean
  attention?: boolean
  preview?: boolean
  description?: string
  testId?: string
  className?: string
  tabRef?: Ref<HTMLButtonElement>
  onSelect: () => void
  onClose: () => void
  onContextMenu?: (event: ReactMouseEvent<HTMLElement>) => void
  onDoubleClick?: (event: ReactMouseEvent<HTMLElement>) => void
  onPointerDown?: (event: ReactPointerEvent<HTMLElement>) => void
  onKeyDown?: (event: ReactKeyboardEvent<HTMLElement>) => void
  [data: `data-${string}`]: string | number | boolean | undefined
}

export function PanelTab({
  id,
  label,
  title,
  icon,
  active,
  controls,
  closeLabel,
  pending,
  muted,
  attention,
  preview,
  description,
  testId,
  className,
  tabRef,
  onSelect,
  onClose,
  onContextMenu,
  onDoubleClick,
  onPointerDown,
  onKeyDown,
  ...data
}: PanelTabProps) {
  const descriptionId = useId()
  return (
    <div
      {...data}
      role="presentation"
      className={cx('ui-ptab', className)}
      data-active={active ? '1' : undefined}
      data-muted={muted ? '' : undefined}
      data-attention={attention ? '' : undefined}
      data-preview={preview ? '' : undefined}
      data-panel-tab={id}
      data-testid={testId}
      onDoubleClick={onDoubleClick}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
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
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={active ? 0 : -1}
        title={title ?? label}
        onClick={onSelect}
      >
        <span className="ui-ptab__text">{label}</span>
      </button>
      {description ? (
        <span id={descriptionId} className="sr-only">
          {description}
        </span>
      ) : null}
    </div>
  )
}

export interface PanelTabListProps extends Omit<HTMLAttributes<HTMLDivElement>, 'role' | 'aria-label' | 'aria-orientation' | 'children'> {
  label: string
  children: ReactNode
  onCloseFocused?: (id: string) => void
  onContextMenuFocused?: (id: string, anchor: HTMLElement) => void
}

function tabsOf(list: HTMLElement): HTMLButtonElement[] {
  return [...list.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
}

export const PanelTabList = forwardRef<HTMLDivElement, PanelTabListProps>(function PanelTabList(
  { label, className, children, onCloseFocused, onContextMenuFocused, onKeyDown: onKeyDownProp, onWheel: onWheelProp, ...rest },
  ref
) {
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    onKeyDownProp?.(event)
    if (event.defaultPrevented) return
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
    else if (
      (event.key === 'Delete' || event.key === 'Backspace') &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      id &&
      onCloseFocused
    ) {
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
      {...rest}
      ref={ref}
      role="tablist"
      aria-label={label}
      aria-orientation="horizontal"
      className={cx('ui-ptabs', className)}
      onKeyDown={onKeyDown}
      onWheel={(event) => {
        onWheelProp?.(event)
        const list = event.currentTarget
        if (event.ctrlKey || list.scrollWidth <= list.clientWidth) return
        const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
        list.scrollLeft += delta
      }}
    >
      {children}
    </div>
  )
})
