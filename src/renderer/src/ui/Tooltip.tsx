import { forwardRef } from 'react'
import {
  Tooltip as RACTooltip,
  TooltipTrigger,
  composeRenderProps,
  type TooltipProps as RACTooltipProps
} from 'react-aria-components'
import { cx } from './cx'

export { TooltipTrigger }
export type { TooltipProps, TooltipTriggerComponentProps } from 'react-aria-components'

export const Tooltip = forwardRef<HTMLDivElement, RACTooltipProps>(function Tooltip({ className, ...props }, ref) {
  return (
    <RACTooltip
      {...props}
      ref={ref}
      className={composeRenderProps(className, (cn) => cx('ui-tooltip', cn))}
    />
  )
})
