import { forwardRef, type HTMLAttributes, type MouseEvent } from 'react'
import {
  Group as RACGroup,
  Input as RACInput,
  composeRenderProps,
  type GroupProps as RACGroupProps,
  type InputProps as RACInputProps
} from 'react-aria-components'
import { cx } from './cx'

export interface InputGroupProps extends RACGroupProps {
  size?: 'sm' | 'md'
  variant?: 'default' | 'ghost'
}

export const InputGroup = forwardRef<HTMLDivElement, InputGroupProps>(function InputGroup(
  { size = 'md', variant = 'default', className, ...props },
  ref
) {
  return (
    <RACGroup
      {...props}
      ref={ref}
      className={composeRenderProps(className, (cn) =>
        cx('ui-input-group', size === 'sm' && 'ui-input-group--sm', variant === 'ghost' && 'ui-input-group--ghost', cn)
      )}
    />
  )
})

export interface InputGroupAddonProps extends HTMLAttributes<HTMLDivElement> {
  align?: 'start' | 'end'
}

const INTERACTIVE = "button, a, input, select, textarea, [role='button'], [role='combobox'], [role='listbox']"

export function InputGroupAddon({ align = 'start', className, onMouseDown, ...rest }: InputGroupAddonProps) {
  return (
    <div
      {...rest}
      data-align={align}
      className={cx('ui-input-group__addon', className)}
      onMouseDown={(event: MouseEvent<HTMLDivElement>) => {
        onMouseDown?.(event)
        if (event.defaultPrevented) return
        const target = event.target as HTMLElement
        if (target.closest(INTERACTIVE)) return
        event.preventDefault()
        const input = event.currentTarget.parentElement?.querySelector<HTMLInputElement>('input, textarea')
        if (input && document.activeElement !== input) input.focus()
      }}
    />
  )
}

export const InputGroupInput = forwardRef<HTMLInputElement, RACInputProps>(function InputGroupInput(
  { className, ...props },
  ref
) {
  return (
    <RACInput
      {...props}
      ref={ref}
      className={composeRenderProps(className, (cn) => cx('ui-input-group__input', cn))}
    />
  )
})

export function InputGroupText({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return <span {...rest} className={cx('ui-input-group__text', className)} />
}
