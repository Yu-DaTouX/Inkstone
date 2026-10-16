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

/** 字段错误文案：字符串，或按 `ValidationResult` 生成。 */
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
  /** 输入框占位文字（RAC 的类型把它省略了，这里补上并转发）。 */
  placeholder?: string
  /** 加到内部 `<input>` 上（版面类，不是控件外观）。 */
  inputClassName?: string
}

/**
 * 单行文本字段。`label` / `description` / `errorMessage` 是常用组合；
 * 需要自定义结构时传 `children`，可直接使用 re-export 的 `Label` / `Input` / `Text`。
 */
export const TextField = forwardRef<HTMLDivElement, TextFieldProps>(function TextField(
  { label, description, errorMessage, placeholder, className, inputClassName, children, ...props },
  ref
) {
  return (
    <RACTextField {...props} ref={ref} className={composeRenderProps(className, (cn) => cx('ui-field', cn))}>
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
  /** 行数提示；跟随内容用 CSS `field-sizing: content`。 */
  rows?: number
}

/**
 * 多行文本。默认跟随内容增高（`field-sizing: content`），可用 `rows` 给一个下限。
 */
export const TextArea = forwardRef<HTMLDivElement, TextAreaProps>(function TextArea(
  { label, description, errorMessage, placeholder, className, textAreaClassName, children, rows = 3, ...props },
  ref
) {
  return (
    <RACTextField {...props} ref={ref} className={composeRenderProps(className, (cn) => cx('ui-field', cn))}>
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

/** 搜索字段：前置放大镜图标，值变化由 RAC 处理（IME 组字安全）。 */
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
