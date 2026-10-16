import { forwardRef, type ReactNode } from 'react'
import {
  Checkbox as RACCheckbox,
  CheckboxGroup as RACCheckboxGroup,
  FieldError,
  Label,
  Text,
  composeRenderProps,
  type CheckboxGroupProps as RACCheckboxGroupProps,
  type CheckboxProps as RACCheckboxProps
} from 'react-aria-components'
import { Check, Minus } from 'lucide-react'
import { cx } from './cx'
import type { FieldErrorContent } from './TextField'

export interface CheckboxProps extends RACCheckboxProps {
  children?: ReactNode
}

export const Checkbox = forwardRef<HTMLLabelElement, CheckboxProps>(function Checkbox(
  { className, children, ...props },
  ref
) {
  return (
    <RACCheckbox {...props} ref={ref} className={composeRenderProps(className, (cn) => cx('ui-checkbox', cn))}>
      {composeRenderProps(children, (kids, values) => (
        <>
          <span className="ui-checkbox__box" aria-hidden="true">
            {values.isIndeterminate ? (
              <Minus className="ui-checkbox__mark" size={13} />
            ) : values.isSelected ? (
              <Check className="ui-checkbox__mark" size={13} />
            ) : null}
          </span>
          {kids != null ? <span className="ui-checkbox__label">{kids}</span> : null}
        </>
      ))}
    </RACCheckbox>
  )
})

export interface CheckboxGroupProps extends RACCheckboxGroupProps {
  label?: ReactNode
  description?: ReactNode
  errorMessage?: FieldErrorContent
  children?: ReactNode
}

export const CheckboxGroup = forwardRef<HTMLDivElement, CheckboxGroupProps>(function CheckboxGroup(
  { label, description, errorMessage, className, children, ...props },
  ref
) {
  return (
    <RACCheckboxGroup
      {...props}
      ref={ref}
      className={composeRenderProps(className, (cn) => cx('ui-checkbox-group', 'ui-field', cn))}
    >
      {label != null ? <Label className="ui-field__label">{label}</Label> : null}
      {children}
      {description != null ? (
        <Text slot="description" className="ui-field__desc">
          {description}
        </Text>
      ) : null}
      <FieldError className="ui-field__error">{errorMessage}</FieldError>
    </RACCheckboxGroup>
  )
})
