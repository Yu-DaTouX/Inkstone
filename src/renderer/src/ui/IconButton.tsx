import { forwardRef, type ReactNode } from 'react'
import { composeRenderProps } from 'react-aria-components'
import { X } from './icons'
import { useOptionalT } from '../i18n'
import { cx } from './cx'
import { Button, type ButtonProps, type ButtonSize } from './Button'
import { CLOSE_ICON_SIZE } from './sizes'

export interface IconButtonProps
  extends Omit<ButtonProps, 'variant' | 'children' | 'icon' | 'trailingIcon' | 'block' | 'justify' | 'size'> {
  'aria-label': string
  variant?: 'ghost' | 'plain' | 'secondary' | 'danger'
  size?: ButtonSize
  pressedTone?: 'accent' | 'neutral' | 'mark'
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
      className={composeRenderProps(className, (cn) => cx('ui-icon-btn', pressedTone === 'neutral' && 'ui-icon-btn--neutral-on', pressedTone === 'mark' && 'ui-icon-btn--mark-on', cn))}
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

export type StopButtonProps = Omit<IconButtonProps, 'children' | 'variant'>

export const StopButton = forwardRef<HTMLButtonElement, StopButtonProps>(function StopButton(
  { size = 'sm', className, ...props },
  ref
) {
  return (
    <IconButton
      {...props}
      ref={ref}
      size={size}
      variant="ghost"
      className={composeRenderProps(className, (cn) => cx('ui-stop-btn', cn))}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
        <rect x="2" y="2" width="8" height="8" rx="1.5" />
      </svg>
    </IconButton>
  )
})
