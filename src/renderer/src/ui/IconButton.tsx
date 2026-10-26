import { forwardRef, type ReactNode } from 'react'
import { composeRenderProps } from 'react-aria-components'
import { cx } from './cx'
import { Button, type ButtonProps, type ButtonSize } from './Button'

export interface IconButtonProps
  extends Omit<ButtonProps, 'variant' | 'children' | 'icon' | 'trailingIcon' | 'block' | 'size'> {
  'aria-label': string
  variant?: 'ghost' | 'plain' | 'secondary' | 'danger'
  size?: ButtonSize
  pressedTone?: 'accent' | 'neutral'
  children: ReactNode
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { variant = 'ghost', size = 'md', pressedTone = 'accent', className, children, ...props },
  ref
) {
  return (
    <Button
      {...props}
      ref={ref}
      variant={variant}
      size={size}
      className={composeRenderProps(className, (cn) => cx('ui-icon-btn', pressedTone === 'neutral' && 'ui-icon-btn--neutral-on', cn))}
    >
      {children}
    </Button>
  )
})
