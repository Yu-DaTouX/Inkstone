import { forwardRef, useCallback, type ReactNode } from 'react'
import {
  Button as RACButton,
  composeRenderProps,
  type ButtonProps as RACButtonProps,
  type TooltipProps as RACTooltipProps
} from 'react-aria-components'
import { cx } from './cx'
import { Tooltip, TooltipHint, TooltipTrigger } from './Tooltip'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'plain' | 'danger' | 'destructive'
export type ButtonSize = 'micro' | 'xs' | 'sm' | 'md'

export interface ButtonProps extends RACButtonProps {
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: ReactNode
  trailingIcon?: ReactNode
  block?: boolean
  justify?: 'center' | 'start'
  title?: string
  tooltip?: ReactNode
  tooltipShortcut?: ReactNode
  tooltipPlacement?: RACTooltipProps['placement']
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    icon,
    trailingIcon,
    block,
    justify = 'center',
    title,
    tooltip,
    tooltipShortcut,
    tooltipPlacement,
    className,
    children,
    ...props
  },
  ref
) {
  const attachRef = useCallback(
    (node: HTMLButtonElement | null) => {
      if (typeof ref === 'function') ref(node)
      else if (ref) (ref as { current: HTMLButtonElement | null }).current = node
      if (node) node.title = title ?? ''
    },
    [ref, title]
  )

  const button = (
    <RACButton
      {...props}
      ref={attachRef}
      className={composeRenderProps(className, (cn) =>
        cx(
          'ui-btn',
          `ui-btn--${variant}`,
          size !== 'md' && `ui-btn--${size}`,
          block && 'ui-btn--block',
          justify === 'start' && 'ui-btn--start',
          cn
        )
      )}
    >
      {composeRenderProps(children, (kids) => (
        <>
          {icon != null ? (
            <span className="ui-btn__icon" aria-hidden="true">
              {icon}
            </span>
          ) : null}
          {kids != null ? <span className="ui-btn__label">{kids}</span> : null}
          {trailingIcon != null ? (
            <span className="ui-btn__icon" aria-hidden="true">
              {trailingIcon}
            </span>
          ) : null}
        </>
      ))}
    </RACButton>
  )
  if (tooltip == null || tooltip === false) return button
  return (
    <TooltipTrigger>
      {button}
      <Tooltip placement={tooltipPlacement}>
        <TooltipHint label={tooltip} shortcut={tooltipShortcut} />
      </Tooltip>
    </TooltipTrigger>
  )
})
