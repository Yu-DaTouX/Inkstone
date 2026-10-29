import { forwardRef, type ReactNode } from 'react'
import {
  Focusable,
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

export interface TooltipVariantProps extends RACTooltipProps {
  variant?: 'default' | 'card'
}

export const Tooltip = forwardRef<HTMLDivElement, TooltipVariantProps>(function Tooltip({ className, offset = 6, variant = 'default', ...props }, ref) {
  return (
    <RACTooltip
      {...props}
      ref={ref}
      offset={offset}
      className={composeRenderProps(className, (cn) => cx('ui-tooltip', variant === 'card' && 'ui-tooltip--card', cn))}
    />
  )
})

export interface TooltipTextProps {
  tooltip: ReactNode
  tooltipShortcut?: ReactNode
  tooltipDetail?: ReactNode
  tooltipPlacement?: RACTooltipProps['placement']
  className?: string
  children: ReactNode
  'data-testid'?: string
}

export function TooltipText({
  tooltip,
  tooltipShortcut,
  tooltipDetail,
  tooltipPlacement,
  className,
  children,
  'data-testid': testId
}: TooltipTextProps) {
  return (
    <TooltipTrigger>
      <Focusable>
        <span tabIndex={0} className={cx('ui-tooltip-text', className)} data-testid={testId}>
          {children}
        </span>
      </Focusable>
      <Tooltip placement={tooltipPlacement}>
        <TooltipHint label={tooltip} shortcut={tooltipShortcut} detail={tooltipDetail} />
      </Tooltip>
    </TooltipTrigger>
  )
}

export interface TooltipHintProps {
  label: ReactNode
  shortcut?: ReactNode
  detail?: ReactNode
}

export function TooltipHint({ label, shortcut, detail }: TooltipHintProps) {
  return (
    <span className={cx('ui-tooltip__stack', shortcut == null && detail == null && 'ui-tooltip__line')}>
      <span className="ui-tooltip__line">
        <span className="ui-tooltip__label">{label}</span>
        {shortcut != null ? <span className="ui-tooltip__shortcut">{shortcut}</span> : null}
      </span>
      {detail != null ? <span className="ui-tooltip__detail">{detail}</span> : null}
    </span>
  )
}
