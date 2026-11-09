import { forwardRef } from 'react'
import { Toolbar as RACToolbar, composeRenderProps, type ToolbarProps } from 'react-aria-components'
import { cx } from './cx'

export type { ToolbarProps }

export const Toolbar = forwardRef<HTMLDivElement, ToolbarProps>(function Toolbar({ className, ...props }, ref) {
  return <RACToolbar {...props} ref={ref} className={composeRenderProps(className, (cn) => cx('ui-toolbar', cn))} />
})
