import type { ReactNode } from 'react'
import {
  Button as RACButton,
  FieldError,
  Label,
  Select as RACSelect,
  SelectValue,
  Text,
  composeRenderProps,
  type SelectProps as RACSelectProps
} from 'react-aria-components'
import { ChevronDown } from './icons'
import { cx } from './cx'
import { CONTROL_ICON_SIZE } from './sizes'
import { ListBox } from './ListBox'
import { Popover } from './Popover'
import type { FieldErrorContent } from './TextField'

export interface SelectProps<T extends object = object> extends Omit<RACSelectProps<T>, 'children'> {
  label?: ReactNode
  description?: ReactNode
  errorMessage?: FieldErrorContent
  placeholder?: string
  children: ReactNode | ((item: T) => ReactNode)
  triggerClassName?: string
  listClassName?: string
  size?: 'md' | 'sm'
}

export function Select<T extends object = object>({
  label,
  description,
  errorMessage,
  placeholder,
  className,
  triggerClassName,
  listClassName,
  size = 'md',
  children,
  ...props
}: SelectProps<T>) {
  return (
    <RACSelect {...props} className={composeRenderProps(className, (cn) => cx('ui-field', 'ui-select', size === 'sm' && 'ui-field--sm ui-select--sm', cn))}>
      {label != null ? <Label className="ui-field__label">{label}</Label> : null}
      <RACButton className={cx('ui-input', 'ui-select__trigger', triggerClassName)}>
        <SelectValue className="ui-select__value">
          {({ isPlaceholder, selectedText }) =>
            isPlaceholder ? <span className="ui-select__placeholder">{placeholder}</span> : selectedText
          }
        </SelectValue>
        <ChevronDown className="ui-select__chevron" size={CONTROL_ICON_SIZE[size]} aria-hidden="true" />
      </RACButton>
      {description != null ? (
        <Text slot="description" className="ui-field__desc">
          {description}
        </Text>
      ) : null}
      <FieldError className="ui-field__error">{errorMessage}</FieldError>
      <Popover offset={6}>
        <ListBox className={cx('ui-listbox--select', listClassName)}>{children}</ListBox>
      </Popover>
    </RACSelect>
  )
}
