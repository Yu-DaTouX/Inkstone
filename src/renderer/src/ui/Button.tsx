import { forwardRef, useCallback, type ReactNode } from 'react'
import {
  Button as RACButton,
  composeRenderProps,
  type ButtonProps as RACButtonProps
} from 'react-aria-components'
import { cx } from './cx'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'plain' | 'danger'
export type ButtonSize = 'sm' | 'md'

export interface ButtonProps extends RACButtonProps {
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: ReactNode
  trailingIcon?: ReactNode
  block?: boolean
  title?: string
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, trailingIcon, block, title, className, children, ...props },
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

  return (
    <RACButton
      {...props}
      ref={attachRef}
      className={composeRenderProps(className, (cn) =>
        cx('ui-btn', `ui-btn--${variant}`, size === 'sm' && 'ui-btn--sm', block && 'ui-btn--block', cn)
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
})
