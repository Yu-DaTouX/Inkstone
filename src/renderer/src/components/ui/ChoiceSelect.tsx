import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button, Menu, MenuItem } from './index'
import { Icon, type IconName } from '../../icons/Icon'
import { useAnchoredPopover } from '../../lib/useAnchoredPopover'
import { useFocusTrap, useModalLayer } from '../../lib/modalLayer'
import { useStore } from '../../state/store'

type ChoiceOption = { value: string; label: string; description?: string; reorderable?: boolean }

/**
 * Inkstone choice menu, shared by permission and provider filters.
 * With `onReorder`, options marked `reorderable` can be dragged (or moved with Alt+↑/↓) into a new order.
 */
export function ChoiceSelect({ value, options, onChange, label, testId, className, disabled = false, menuWidth = 300, align = 'right', icon, onReorder, reorderHint }: {
  value: string; options: ChoiceOption[]
  onChange(value: string): void; label: string; testId?: string; className?: string; disabled?: boolean
  /** 选项带两行说明时加宽，避免说明折成孤字 */
  menuWidth?: number
  /** 菜单对齐触发器的哪一侧；触发器在输入框左侧时用 left */
  align?: 'left' | 'right'
  /** 前置图标；窄容器里样式可以只留图标（文字在 .ui-choice-text 里） */
  icon?: IconName
  onReorder?(values: string[]): void
  reorderHint?: string
}) {
  const [open, setOpen] = useState(false)
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const id = useId()
  const position = useAnchoredPopover(open, trigger, menuWidth, 360, true, align)
  const { isTop } = useModalLayer(open, () => setOpen(false))
  useFocusTrap(menu, open, isTop)
  useEffect(() => {
    if (!open) return
    const release = useStore.getState().acquireOverlayBlocker('choice-menu')
    const close = (event: MouseEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false)
    }
    menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus()
    document.addEventListener('mousedown', close)
    return () => { release(); document.removeEventListener('mousedown', close) }
  }, [open])
  const movable = options.filter(o => o.reorderable).map(o => o.value)
  const move = (from: string, to: string) => {
    if (!onReorder || from === to) return
    const next = movable.filter(v => v !== from)
    const at = next.indexOf(to)
    if (at < 0) return
    next.splice(movable.indexOf(from) < movable.indexOf(to) ? at + 1 : at, 0, from)
    onReorder(next)
  }
  return <>
    <Button ref={trigger} size="sm" variant="ghost" className={`ui-choice-trigger${className ? ` ${className}` : ''}`} disabled={disabled}
      data-testid={testId} title={label} aria-label={`${label}: ${options.find(o => o.value === value)?.label ?? value}`}
      aria-haspopup="menu" aria-controls={open ? id : undefined} aria-expanded={open}
      icon={icon} trailingIcon="chevron-right" onClick={() => setOpen(v => !v)}>
      <span className="ui-choice-text">{options.find(o => o.value === value)?.label ?? value}</span>
    </Button>
    {open ? createPortal(<Menu ref={menu} id={id} label={label} className="ui-choice-menu" style={position}
      onKeyDown={event => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        event.preventDefault(); event.stopPropagation()
        const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
        const current = items.indexOf(document.activeElement as HTMLButtonElement)
        const focused = items[current]?.dataset.value
        if (event.altKey && onReorder && focused && movable.includes(focused) && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
          const target = movable[movable.indexOf(focused) + (event.key === 'ArrowDown' ? 1 : -1)]
          if (target) {
            move(focused, target)
            window.setTimeout(() => menu.current?.querySelector<HTMLButtonElement>(`[data-value="${CSS.escape(focused)}"]`)?.focus(), 0)
          }
          return
        }
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
        items[next]?.focus()
      }}>
      {options.map(option => {
        const canDrag = !!onReorder && !!option.reorderable
        return <MenuItem key={option.value} role="menuitemradio" aria-checked={option.value === value}
          data-value={option.value} draggable={canDrag}
          data-dragging={dragging === option.value ? '1' : undefined}
          data-drop={over === option.value && dragging && dragging !== option.value ? '1' : undefined}
          className={`ui-choice-option${canDrag ? ' reorderable' : ''}`}
          onClick={() => { onChange(option.value); setOpen(false) }}
          onDragStart={canDrag ? event => { setDragging(option.value); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', option.value) } : undefined}
          onDragOver={canDrag ? event => { if (!dragging) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setOver(option.value) } : undefined}
          onDrop={canDrag ? event => { event.preventDefault(); if (dragging) move(dragging, option.value); setDragging(null); setOver(null) } : undefined}
          onDragEnd={canDrag ? () => { setDragging(null); setOver(null) } : undefined}>
          <span className="ui-choice-check" aria-hidden>{option.value === value ? <Icon name="check" size={12} /> : null}</span>
          <span className="ui-choice-copy"><span>{option.label}</span>
            {option.description ? <span className="ui-row-desc">{option.description}</span> : null}</span>
          {canDrag ? <span className="ui-choice-grip" aria-hidden><Icon name="menu" size={12} /></span> : null}
        </MenuItem>
      })}
      {onReorder && reorderHint && movable.length > 1 ? <div className="ui-choice-hint">{reorderHint}</div> : null}
    </Menu>, document.body) : null}
  </>
}
