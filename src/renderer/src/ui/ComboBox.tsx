import type { ReactNode } from 'react'
import {
  Button as RACButton,
  ComboBox as RACComboBox,
  FieldError,
  Input as RACInput,
  Label,
  Text,
  composeRenderProps,
  type ComboBoxProps as RACComboBoxProps
} from 'react-aria-components'
import { ChevronDown } from 'lucide-react'
import { cx } from './cx'
import { ListBox } from './ListBox'
import { Popover } from './Popover'
import type { FieldErrorContent } from './TextField'

export interface ComboBoxProps<T extends object = object> extends Omit<RACComboBoxProps<T>, 'children'> {
  label?: ReactNode
  description?: ReactNode
  errorMessage?: FieldErrorContent
  inputPlaceholder?: string
  children: ReactNode | ((item: T) => ReactNode)
  inputClassName?: string
  listClassName?: string
}

export function ComboBox<T extends object = object>({
  label,
  description,
  errorMessage,
  inputPlaceholder,
  className,
  inputClassName,
  listClassName,
  children,
  ...props
}: ComboBoxProps<T>) {
  return (
    <RACComboBox {...props} className={composeRenderProps(className, (cn) => cx('ui-field', 'ui-combo', cn))}>
      {label != null ? <Label className="ui-field__label">{label}</Label> : null}
      <div className="ui-combo__box">
        <RACInput className={cx('ui-input', 'ui-combo__input', inputClassName)} placeholder={inputPlaceholder} />
        <RACButton className="ui-combo__toggle">
          <ChevronDown size={16} aria-hidden="true" />
        </RACButton>
      </div>
      {description != null ? (
        <Text slot="description" className="ui-field__desc">
          {description}
        </Text>
      ) : null}
      <FieldError className="ui-field__error">{errorMessage}</FieldError>
      <Popover offset={4}>
        <ListBox className={listClassName}>{children}</ListBox>
      </Popover>
    </RACComboBox>
  )
}
