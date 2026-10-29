import { forwardRef, type ReactNode, type Ref } from 'react'
import { TextField as RACTextField } from 'react-aria-components'
import { ChevronDown, ChevronUp, Search } from 'lucide-react'
import { useOptionalT } from '../i18n'
import { cx } from './cx'
import { CloseButton, IconButton } from './IconButton'
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from './InputGroup'
import { Toggle } from './Toggle'
import { CONTROL_ICON_SIZE } from './sizes'

export interface FindBarOption {
  id: string
  label: string
  icon: ReactNode
  selected: boolean
}

export interface FindBarLabels {
  input?: string
  previous?: string
  next?: string
  close?: string
}

export interface FindBarProps {
  value: string
  onChange: (value: string) => void
  onNext: () => void
  onPrevious: () => void
  onClose?: () => void
  matchIndex?: number | null
  matchCount?: number | null
  status?: ReactNode
  options?: readonly FindBarOption[]
  onOptionChange?: (id: string, selected: boolean) => void
  placeholder?: string
  labels?: FindBarLabels
  autoFocus?: boolean
  inputRef?: Ref<HTMLInputElement>
  className?: string
  'data-testid'?: string
}

export const FindBar = forwardRef<HTMLDivElement, FindBarProps>(function FindBar(
  {
    value,
    onChange,
    onNext,
    onPrevious,
    onClose,
    matchIndex,
    matchCount,
    status,
    options,
    onOptionChange,
    placeholder,
    labels,
    autoFocus = true,
    inputRef,
    className,
    'data-testid': testId
  },
  ref
) {
  const t = useOptionalT()
  const hasQuery = value.length > 0
  const count = matchCount ?? null
  const empty = hasQuery && count === 0
  const counter =
    status ?? (hasQuery && count != null ? `${count === 0 ? 0 : (matchIndex ?? 0) + 1}/${count}` : null)
  const navDisabled = !hasQuery || count === 0
  return (
    <div ref={ref} role="search" className={cx('ui-findbar', className)} data-testid={testId}>
      <RACTextField
        aria-label={labels?.input ?? t('chat.find')}
        value={value}
        onChange={onChange}
        autoFocus={autoFocus}
        className="ui-findbar__field"
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return
          if (event.key === 'Enter') {
            event.preventDefault()
            if (event.shiftKey) onPrevious()
            else onNext()
          } else if (event.key === 'Escape' && onClose) {
            event.preventDefault()
            onClose()
          } else {
            event.continuePropagation()
          }
        }}
      >
        <InputGroup size="sm" data-empty={empty ? 'true' : undefined}>
          <InputGroupAddon align="start">
            <Search size={CONTROL_ICON_SIZE.sm} aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput ref={inputRef} placeholder={placeholder ?? t('chat.findPlaceholder')} />
          {counter != null || (options != null && options.length > 0) ? (
            <InputGroupAddon align="end">
              {counter != null ? (
                <InputGroupText className="ui-findbar__count" aria-live="polite">
                  {counter}
                </InputGroupText>
              ) : null}
              {options?.map((option) => (
                <Toggle
                  key={option.id}
                  size="micro"
                  icon
                  aria-label={option.label}
                  tooltip={option.label}
                  isSelected={option.selected}
                  onChange={(selected) => onOptionChange?.(option.id, selected)}
                >
                  {option.icon}
                </Toggle>
              ))}
            </InputGroupAddon>
          ) : null}
        </InputGroup>
      </RACTextField>
      <span className="ui-findbar__nav">
        <IconButton size="sm" aria-label={labels?.previous ?? t('chat.findPrev')} tooltip={labels?.previous ?? t('chat.findPrev')} tooltipShortcut="Shift+Enter" isDisabled={navDisabled} onPress={onPrevious}>
          <ChevronUp size={CONTROL_ICON_SIZE.sm} aria-hidden="true" />
        </IconButton>
        <IconButton size="sm" aria-label={labels?.next ?? t('chat.findNext')} tooltip={labels?.next ?? t('chat.findNext')} tooltipShortcut="Enter" isDisabled={navDisabled} onPress={onNext}>
          <ChevronDown size={CONTROL_ICON_SIZE.sm} aria-hidden="true" />
        </IconButton>
        {onClose ? <CloseButton size="sm" aria-label={labels?.close ?? t('chat.findClose')} tooltip={labels?.close ?? t('chat.findClose')} tooltipShortcut="Esc" onPress={onClose} /> : null}
      </span>
    </div>
  )
})
