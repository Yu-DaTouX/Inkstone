import { forwardRef } from 'react'
import {
  Tooltip as RACTooltip,
  TooltipTrigger as RACTooltipTrigger,
  composeRenderProps,
  type TooltipProps as RACTooltipProps,
  type TooltipTriggerComponentProps
} from 'react-aria-components'
import { cx } from './cx'

export type { TooltipProps, TooltipTriggerComponentProps } from 'react-aria-components'

export const TOOLTIP_OPEN_DELAY_MS = 300
export const TOOLTIP_CLOSE_DELAY_MS = 200

export function TooltipTrigger(props: TooltipTriggerComponentProps) {
  return <RACTooltipTrigger delay={TOOLTIP_OPEN_DELAY_MS} closeDelay={TOOLTIP_CLOSE_DELAY_MS} {...props} />
}

export const Tooltip = forwardRef<HTMLDivElement, RACTooltipProps>(function Tooltip({ className, offset = 6, ...props }, ref) {
  return (
    <RACTooltip
      {...props}
      ref={ref}
      offset={offset}
      className={composeRenderProps(className, (cn) => cx('ui-tooltip', cn))}
    />
  )
})
