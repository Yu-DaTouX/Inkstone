import { forwardRef, type ReactNode } from 'react'
import { composeRenderProps } from 'react-aria-components'
import { X } from 'lucide-react'
import { useOptionalT } from '../i18n'
import { cx } from './cx'
import { Button, type ButtonProps, type ButtonSize } from './Button'
import { CLOSE_ICON_SIZE } from './sizes'

export interface IconButtonProps
  extends Omit<ButtonProps, 'variant' | 'children' | 'icon' | 'trailingIcon' | 'block' | 'justify' | 'size'> {
  'aria-label': string
  variant?: 'ghost' | 'plain' | 'secondary' | 'danger'
  size?: ButtonSize
  pressedTone?: 'accent' | 'neutral' | 'outline'
  children: ReactNode
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    variant = 'ghost',
    size = 'md',
    pressedTone = 'accent',
    className,
    children,
    ...props
  },
  ref
) {
  return (
    <Button
      {...props}
      ref={ref}
      variant={variant}
      size={size}
      className={composeRenderProps(className, (cn) => cx('ui-icon-btn', pressedTone === 'neutral' && 'ui-icon-btn--neutral-on', pressedTone === 'outline' && 'ui-icon-btn--outline-on', cn))}
    >
      {children}
    </Button>
  )
})

export interface CloseButtonProps extends Omit<IconButtonProps, 'children' | 'aria-label'> {
  'aria-label'?: string
}

export const CloseButton = forwardRef<HTMLButtonElement, CloseButtonProps>(function CloseButton(
  { size = 'sm', className, 'aria-label': ariaLabel, ...props },
  ref
) {
  const t = useOptionalT()
  return (
    <IconButton
      {...props}
      ref={ref}
      size={size}
      aria-label={ariaLabel ?? t('ui.close')}
      className={composeRenderProps(className, (cn) => cx('ui-close-btn', cn))}
    >
      <X size={CLOSE_ICON_SIZE[size]} aria-hidden="true" />
    </IconButton>
  )
})
