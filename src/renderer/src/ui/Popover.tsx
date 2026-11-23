import { forwardRef } from 'react'
import { Popover as RACPopover, composeRenderProps, type PopoverProps as RACPopoverProps } from 'react-aria-components'
import { cx } from './cx'

export interface PopoverProps extends RACPopoverProps {
  variant?: 'menu' | 'panel'
  surface?: 'glass' | 'solid'
}

function densityScopeOf(element: Element | null | undefined): string | undefined {
  const scope = element?.closest('[data-density-scope]')?.getAttribute('data-density-scope')
  return scope ?? undefined
}

export const Popover = forwardRef<HTMLElement, PopoverProps>(function Popover({ className, variant = 'menu', surface = 'glass', triggerRef, ...props }, ref) {
  const scope = densityScopeOf(triggerRef?.current) ?? densityScopeOf(document.activeElement)
  return (
    <RACPopover
      {...props}
      triggerRef={triggerRef}
      data-density-scope={scope}
      data-workspace-ui=""
      ref={ref}
      className={composeRenderProps(className, (cn) => cx('ui-popover ui-float', surface === 'solid' && 'ui-float--solid', variant === 'panel' && 'ui-popover--panel', cn))}
    />
  )
})
