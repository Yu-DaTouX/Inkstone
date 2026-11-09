import { Fragment, useMemo } from 'react'
import { Menu, MenuItem, MenuSeparator, Popover } from '../../../ui'

export interface TabContextMenuItem {
  id: string
  label: string
  shortcut?: string
  disabled?: boolean
  disabledReason?: string
  separatorBefore?: boolean
  danger?: boolean
  onSelect: () => void
}

export interface TabContextMenuProps {
  anchor: HTMLElement | null
  open: boolean
  label: string
  items: readonly TabContextMenuItem[]
  onOpenChange: (open: boolean) => void
}

export function TabContextMenu(props: TabContextMenuProps) {
  const triggerRef = useMemo(() => ({ current: props.anchor }), [props.anchor])
  if (!props.anchor) return null
  return (
    <Popover triggerRef={triggerRef} isOpen={props.open} onOpenChange={props.onOpenChange} placement="bottom start" offset={4}>
      <Menu aria-label={props.label} autoFocus="first" onClose={() => props.onOpenChange(false)}>
        {props.items.map((item) => (
          <Fragment key={item.id}>
            {item.separatorBefore ? <MenuSeparator /> : null}
            <MenuItem
              id={item.id}
              textValue={item.label}
              tone={item.danger ? 'danger' : 'default'}
              isDisabled={item.disabled}
              disabledReason={item.disabledReason}
              shortcut={item.shortcut}
              aria-keyshortcuts={item.shortcut}
              onAction={item.onSelect}
            >
              {item.label}
            </MenuItem>
          </Fragment>
        ))}
      </Menu>
    </Popover>
  )
}
