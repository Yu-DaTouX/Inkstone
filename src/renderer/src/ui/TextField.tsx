import { forwardRef, type ReactNode } from 'react'
import {
  FieldError,
  Input as RACInput,
  Label,
  SearchField as RACSearchField,
  Text,
  TextArea as RACTextArea,
  TextField as RACTextField,
  composeRenderProps,
  type SearchFieldProps as RACSearchFieldProps,
  type TextFieldProps as RACTextFieldProps,
  type ValidationResult
} from 'react-aria-components'
import { Search } from 'lucide-react'
import { cx } from './cx'

export type FieldErrorContent = ReactNode | ((validation: ValidationResult) => ReactNode)

function FieldHead({ label }: { label?: ReactNode }) {
  return label != null ? <Label className="ui-field__label">{label}</Label> : null
}

function FieldFoot({ description, errorMessage }: { description?: ReactNode; errorMessage?: FieldErrorContent }) {
  return (
    <>
      {description != null ? (
        <Text slot="description" className="ui-field__desc">
          {description}
        </Text>
      ) : null}
      <FieldError className="ui-field__error">{errorMessage}</FieldError>
    </>
  )
}

export interface TextFieldProps extends RACTextFieldProps {
  label?: ReactNode
  description?: ReactNode
  errorMessage?: FieldErrorContent
  placeholder?: string
  inputClassName?: string
  size?: 'md' | 'sm'
}

export const TextField = forwardRef<HTMLDivElement, TextFieldProps>(function TextField(
  { label, description, errorMessage, placeholder, className, inputClassName, size = 'md', children, ...props },
  ref
) {
  return (
    <RACTextField {...props} ref={ref} className={composeRenderProps(className, (cn) => cx('ui-field', size === 'sm' && 'ui-field--sm', cn))}>
      {children ?? (
        <>
          <FieldHead label={label} />
          <RACInput className={cx('ui-input', inputClassName)} placeholder={placeholder} />
          <FieldFoot description={description} errorMessage={errorMessage} />
        </>
      )}
    </RACTextField>
  )
})

export interface TextAreaProps extends RACTextFieldProps {
  label?: ReactNode
  description?: ReactNode
  errorMessage?: FieldErrorContent
  placeholder?: string
  textAreaClassName?: string
  rows?: number
  size?: 'md' | 'sm'
}

export const TextArea = forwardRef<HTMLDivElement, TextAreaProps>(function TextArea(
  { label, description, errorMessage, placeholder, className, textAreaClassName, children, rows = 3, size = 'md', ...props },
  ref
) {
  return (
    <RACTextField {...props} ref={ref} className={composeRenderProps(className, (cn) => cx('ui-field', size === 'sm' && 'ui-field--sm', cn))}>
      {children ?? (
        <>
          <FieldHead label={label} />
          <RACTextArea className={cx('ui-textarea', textAreaClassName)} rows={rows} placeholder={placeholder} />
          <FieldFoot description={description} errorMessage={errorMessage} />
        </>
      )}
    </RACTextField>
  )
})

export interface SearchFieldProps extends RACSearchFieldProps {
  label?: ReactNode
  description?: ReactNode
  errorMessage?: FieldErrorContent
  placeholder?: string
  inputClassName?: string
}

export const SearchField = forwardRef<HTMLDivElement, SearchFieldProps>(function SearchField(
  { label, description, errorMessage, placeholder, className, inputClassName, ...props },
  ref
) {
  return (
    <RACSearchField
      {...props}
      ref={ref}
      className={composeRenderProps(className, (cn) => cx('ui-field', 'ui-search', cn))}
    >
      {label != null ? <Label className="ui-field__label">{label}</Label> : null}
      <div className="ui-search__box">
        <Search className="ui-search__icon" size={15} aria-hidden="true" />
        <RACInput className={cx('ui-input', 'ui-search__input', inputClassName)} placeholder={placeholder} />
      </div>
      <FieldFoot description={description} errorMessage={errorMessage} />
    </RACSearchField>
  )
})
