import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
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

const MENUITEM_SELECTOR = '[role="menuitem"]:not([disabled]):not([aria-disabled="true"])'

/**
 * 菜单外壳：Portal 到 `document.body` + fixed 定位 + 四周夹取 + 键盘导航 + 外点关闭。
 *
 * 为什么必须走 Portal：菜单挂在行内会被 `overflow` 裁掉（长列表的最后几行、
 * 窄栏、缩放 150% 都会露出来），也会把行的 `scrollHeight` 顶大。
 *
 * 两种内容都走这一层：
 *   · 纯动作列表 → `ContextMenu`（items）
 *   · 带信息行 / 分区 / 自定义行（会话菜单）→ 直接给 children，
 *     其中可选项自己标 `role="menuitem"`，键盘导航才能找到它们。
 */
export function ContextMenuSurface({
  open,
  anchor,
  onClose,
  testid,
  className = 'ctx-menu',
  children,
  ...rest
}: {
  open: boolean
  anchor: ContextMenuAnchor | null
  onClose: () => void
  testid?: string
  className?: string
  children: ReactNode
  /** 透传 `data-*`（探针按会话 / 分组定位菜单，验证菜单归属） */
  [dataAttr: `data-${string}`]: string | undefined
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const acquireOverlayBlocker = useStore((s) => s.acquireOverlayBlocker)

  /* 四周夹回视口：量内容实际尺寸，再把 anchor 夹进可用区 */
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
    /*
     * 内容会异步变高（标题候选刚出现、可移动的项目行很多）：只量一次会算错
     * 底部边界，菜单从下沿露出去。尺寸变化后再夹一次。
     */
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

  /* 打开即聚焦第一项；只有信息行时聚焦容器，键盘仍然进得来 */
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

/**
 * 通用上下文菜单（实施-12 U-2）：动作列表版本，基于 `ContextMenuSurface`。
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
  return (
    <ContextMenuSurface open={open} anchor={anchor} onClose={onClose} testid={testid}>
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
    </ContextMenuSurface>
  )
}
