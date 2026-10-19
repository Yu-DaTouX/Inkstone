import { useEffect, useRef, type JSX } from 'react'
import { Menu, MenuItem, Popover } from '../../ui'
import { closeMessageMenu, registerMessageMenuHost, useMessageMenu } from './message-menu'

export function MessageMenuHost(): JSX.Element {
  const request = useMessageMenu()
  const anchor = useRef<HTMLSpanElement>(null)
  useEffect(() => registerMessageMenuHost(), [])
  return (
    <>
      <span
        ref={anchor}
        className="v3-msgmenu-anchor"
        aria-hidden
        style={request ? { left: request.x, top: request.y } : undefined}
      />
      {request ? (
        <Popover
          triggerRef={anchor}
          isOpen
          onOpenChange={(open) => { if (!open) closeMessageMenu() }}
          placement="bottom start"
          offset={2}
        >
          <Menu
            aria-label={request.label}
            autoFocus="first"
            data-testid="v3-message-menu"
            onAction={(key) => {
              const item = request.items.find((entry) => entry.id === key)
              closeMessageMenu()
              item?.run()
            }}
            onClose={closeMessageMenu}
          >
            {request.items.map((item) => (
              <MenuItem key={item.id} id={item.id} textValue={item.label}>{item.label}</MenuItem>
            ))}
          </Menu>
        </Popover>
      ) : null}
    </>
  )
}
