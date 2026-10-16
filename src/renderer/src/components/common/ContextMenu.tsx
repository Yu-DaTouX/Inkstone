import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../icons/Icon'
import { useStore } from '../../state/store'

export interface ContextMenuItem {
  id: string
  label: string
  icon?: Parameters<typeof Icon>[0]['name']
  danger?: boolean
  disabled?: boolean
  onSelect: () => void
}

export interface ContextMenuAnchor {
  x: number
  y: number
  trigger?: HTMLElement | null
}

const MENUITEM_SELECTOR = '[role="menuitem"]:not([disabled]):not([aria-disabled="true"])'

export function ContextMenuSurface({
  open,
  anchor,
  onClose,
  testid,
  className = 'ctx-menu ui-menu',
  children,
  ...rest
}: {
  open: boolean
  anchor: ContextMenuAnchor | null
  onClose: () => void
  testid?: string
  className?: string
  children: ReactNode
  [dataAttr: `data-${string}`]: string | undefined
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const acquireOverlayBlocker = useStore((s) => s.acquireOverlayBlocker)

  const place = useCallback((): void => {
    const el = ref.current
    if (!el || !anchor) return
    const rect = el.getBoundingClientRect()
    const margin = 8
    const maxX = Math.max(margin, window.innerWidth - rect.width - margin)
    const maxY = Math.max(margin, window.innerHeight - rect.height - margin)
    setPos({
      x: Math.min(Math.max(margin, anchor.x), maxX),
      y: Math.min(Math.max(margin, anchor.y), maxY)
    })
  }, [anchor])

  useLayoutEffect(() => {
    if (!open) return undefined
    place()
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(() => place())
    observer.observe(el)
    return () => observer.disconnect()
  }, [open, place])

  useEffect(() => {
    if (!open) return undefined
    const onResize = (): void => place()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [open, place])

  useEffect(() => {
    if (!open) return
    const el = ref.current
    if (!el) return
    const first = el.querySelector<HTMLElement>(MENUITEM_SELECTOR)
    ;(first ?? el).focus()
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    return acquireOverlayBlocker('context-menu')
  }, [open, acquireOverlayBlocker])

  useEffect(() => {
    if (!open) return undefined
    const onDown = (event: MouseEvent): void => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open, onClose])

  if (!open || !anchor) return null

  const move = (delta: number): void => {
    const all = Array.from(ref.current?.querySelectorAll<HTMLElement>(MENUITEM_SELECTOR) ?? [])
    if (!all.length) return
    const current = all.indexOf(document.activeElement as HTMLElement)
    const from = current < 0 ? (delta > 0 ? -1 : 0) : current
    const next = ((from + delta) % all.length + all.length) % all.length
    all[next]?.focus()
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      move(1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      move(-1)
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const all = Array.from(ref.current?.querySelectorAll<HTMLElement>(MENUITEM_SELECTOR) ?? [])
      all[event.key === 'Home' ? 0 : all.length - 1]?.focus()
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault()
      onClose()
    }
  }

  return createPortal(
    <div
      ref={ref}
      {...rest}
      className={className}
      role="menu"
      data-testid={testid}
      tabIndex={-1}
      style={{ left: pos.x, top: pos.y }}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {children}
    </div>,
    document.body
  )
}

export function ContextMenu({
  open,
  anchor,
  items,
  onClose,
  testid
}: {
  open: boolean
  anchor: ContextMenuAnchor | null
  items: ContextMenuItem[]
  onClose: () => void
  testid?: string
}) {
  return (
    <ContextMenuSurface open={open} anchor={anchor} onClose={onClose} testid={testid}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          className={`ui-menu-item ${item.danger ? 'danger' : ''}`}
          data-testid={item.id}
          aria-disabled={item.disabled ? 'true' : undefined}
          disabled={item.disabled}
          onClick={() => {
            if (item.disabled) return
            item.onSelect()
            onClose()
          }}
        >
          {item.icon ? <Icon name={item.icon} size={12} /> : null}
          <span>{item.label}</span>
        </button>
      ))}
    </ContextMenuSurface>
  )
}
