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
import { ChevronDown } from 'lucide-react'
import { cx } from './cx'
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
}

export function Select<T extends object = object>({
  label,
  description,
  errorMessage,
  placeholder,
  className,
  triggerClassName,
  listClassName,
  children,
  ...props
}: SelectProps<T>) {
  return (
    <RACSelect {...props} className={composeRenderProps(className, (cn) => cx('ui-field', 'ui-select', cn))}>
      {label != null ? <Label className="ui-field__label">{label}</Label> : null}
      <RACButton className={cx('ui-input', 'ui-select__trigger', triggerClassName)}>
        <SelectValue className="ui-select__value">
          {({ isPlaceholder, selectedText }) =>
            isPlaceholder ? <span className="ui-select__placeholder">{placeholder}</span> : selectedText
          }
        </SelectValue>
        <ChevronDown className="ui-select__chevron" size={16} aria-hidden="true" />
      </RACButton>
      {description != null ? (
        <Text slot="description" className="ui-field__desc">
          {description}
        </Text>
      ) : null}
      <FieldError className="ui-field__error">{errorMessage}</FieldError>
      <Popover offset={4}>
        <ListBox className={listClassName}>{children}</ListBox>
      </Popover>
    </RACSelect>
  )
}
