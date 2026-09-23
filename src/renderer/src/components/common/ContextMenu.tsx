import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../icons/Icon'
import { useStore } from '../../state/store'

/** 一个菜单项；`onSelect` 返回后菜单自动关闭 */
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
  /** 关闭后把焦点还给它（右键点在哪一行、省略号按钮是谁） */
  trigger?: HTMLElement | null
}

/**
 * 通用上下文菜单（实施-12 U-2）。
 *
 * 为什么必须走 Portal：菜单挂在行内会被 `overflow` 裁掉（长列表、窄栏、
 * 缩放 150% 都会露出来），也会把行的 `scrollHeight` 顶大。这里渲染到
 * `document.body`，用 fixed 定位，四周都夹回视口内。
 *
 * 键盘：打开即聚焦第一项；↑/↓/Home/End 在项间移动；Enter/Space 选中；
 * Esc / Tab 关闭并把焦点还给触发元素。打开期间领一个 overlay blocker
 * （H-9a），原生网页让位。
 */
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
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const acquireOverlayBlocker = useStore((s) => s.acquireOverlayBlocker)

  useLayoutEffect(() => {
    if (!open || !anchor) return
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const margin = 8
    const maxX = Math.max(margin, window.innerWidth - rect.width - margin)
    const maxY = Math.max(margin, window.innerHeight - rect.height - margin)
    setPos({ x: Math.min(Math.max(margin, anchor.x), maxX), y: Math.min(Math.max(margin, anchor.y), maxY) })
  }, [open, anchor, items.length])

  /* 打开即聚焦第一项（键盘用户不用先 Tab 进去） */
  useEffect(() => {
    if (!open) return
    const first = ref.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')
    first?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    return acquireOverlayBlocker('context-menu')
  }, [open, acquireOverlayBlocker])

  const focusAt = useCallback((index: number): void => {
    const all = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? [])
    if (!all.length) return
    const next = ((index % all.length) + all.length) % all.length
    all[next]?.focus()
  }, [])

  useEffect(() => {
    if (!open) return undefined
    const onDown = (event: MouseEvent): void => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open, onClose])

  if (!open || !anchor) return null

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const all = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? [])
    const current = all.indexOf(document.activeElement as HTMLElement)
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusAt(current + 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      focusAt(current - 1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      focusAt(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      focusAt(all.length - 1)
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault()
      onClose()
    }
  }

  return createPortal(
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      data-testid={testid}
      style={{ left: pos.x, top: pos.y }}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          className={`ctx-menu-item ${item.danger ? 'danger' : ''}`}
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
    </div>,
    document.body
  )
}
