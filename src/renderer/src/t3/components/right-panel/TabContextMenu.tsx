import { Fragment } from 'react'
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuShortcut } from '@/t3/components/ui/menu'
import { DisabledReasonTooltip } from './Launcher'

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

function ContextMenuItemRow(props: { item: TabContextMenuItem }) {
  const { item } = props
  const entry = (
    <MenuItem
      variant={item.danger ? 'destructive' : 'default'}
      className={item.disabled ? 'data-disabled:pointer-events-auto' : undefined}
      disabled={item.disabled}
      aria-keyshortcuts={item.shortcut}
      onClick={() => {
        if (item.disabled) return
        item.onSelect()
      }}
    >
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.shortcut ? <MenuShortcut>{item.shortcut}</MenuShortcut> : null}
    </MenuItem>
  )
  if (!item.disabled || !item.disabledReason) return entry
  return <DisabledReasonTooltip reason={item.disabledReason} trigger={entry} />
}

export function TabContextMenu(props: TabContextMenuProps) {
  if (!props.anchor) return null
  return (
    <Menu open={props.open} onOpenChange={props.onOpenChange}>
      <MenuPopup
        anchor={props.anchor}
        align="start"
        side="bottom"
        sideOffset={4}
        aria-label={props.label}
      >
        {props.items.map((item) => (
          <Fragment key={item.id}>
            {item.separatorBefore ? <MenuSeparator /> : null}
            <ContextMenuItemRow item={item} />
          </Fragment>
        ))}
      </MenuPopup>
    </Menu>
  )
}
