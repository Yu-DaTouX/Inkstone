import { forwardRef } from 'react'
import { Popover as RACPopover, composeRenderProps, type PopoverProps as RACPopoverProps } from 'react-aria-components'
import { cx } from './cx'

export interface PopoverProps extends RACPopoverProps {
  variant?: 'menu' | 'panel'
}

export const Popover = forwardRef<HTMLElement, PopoverProps>(function Popover({ className, variant = 'menu', ...props }, ref) {
  return (
    <RACPopover
      {...props}
      ref={ref}
      className={composeRenderProps(className, (cn) => cx('ui-popover', variant === 'panel' && 'ui-popover--panel', cn))}
    />
  )
})
