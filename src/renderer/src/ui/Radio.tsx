import { forwardRef, type ReactNode } from 'react'
import {
  FieldError,
  Label,
  Radio as RACRadio,
  RadioGroup as RACRadioGroup,
  Text,
  composeRenderProps,
  type RadioGroupProps as RACRadioGroupProps,
  type RadioProps as RACRadioProps
} from 'react-aria-components'
import { cx } from './cx'
import type { FieldErrorContent } from './TextField'

export interface RadioProps extends RACRadioProps {
  children?: ReactNode
}

/** 单选项。圆点由 CSS 依据 `[data-selected]` 绘制。 */
export const Radio = forwardRef<HTMLLabelElement, RadioProps>(function Radio(
  { className, children, ...props },
  ref
) {
  return (
    <RACRadio {...props} ref={ref} className={composeRenderProps(className, (cn) => cx('ui-radio', cn))}>
      {composeRenderProps(children, (kids) => (
        <>
          <span className="ui-radio__dot" aria-hidden="true" />
          {kids != null ? <span className="ui-radio__label">{kids}</span> : null}
        </>
      ))}
    </RACRadio>
  )
})

export interface RadioGroupProps extends RACRadioGroupProps {
  label?: ReactNode
  description?: ReactNode
  errorMessage?: FieldErrorContent
  children?: ReactNode
}

/**
 * 单选组。方向键在组内移动选择、`Tab` 离开整组，由 RAC 的漫游焦点实现。
 * 想表达「开关」用 `Switch`，不要用只有两项的单选组。
 */
export const RadioGroup = forwardRef<HTMLDivElement, RadioGroupProps>(function RadioGroup(
  { label, description, errorMessage, className, children, ...props },
  ref
) {
  return (
    <RACRadioGroup
      {...props}
      ref={ref}
      className={composeRenderProps(className, (cn) => cx('ui-radio-group', 'ui-field', cn))}
    >
      {label != null ? <Label className="ui-field__label">{label}</Label> : null}
      {children}
      {description != null ? (
        <Text slot="description" className="ui-field__desc">
          {description}
        </Text>
      ) : null}
      <FieldError className="ui-field__error">{errorMessage}</FieldError>
    </RACRadioGroup>
  )
})
