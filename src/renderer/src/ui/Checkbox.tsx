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
  /** 勾选框后面的文字。 */
  children?: ReactNode
}

/**
 * 复选框。`children` 是可见文字，`aria-label` 只在没有文字时使用。
 * 三种状态（未选 / 已选 / 半选）由 RAC 的 `isIndeterminate` 表达。
 */
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

/** 复选框组：负责把 `Label` / 描述 / 错误与内部的复选框用 ARIA 关联起来。 */
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
