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
  testId?: string
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
  hasMatches?: boolean
  status?: ReactNode
  options?: readonly FindBarOption[]
  onOptionChange?: (id: string, selected: boolean) => void
  placeholder?: string
  labels?: FindBarLabels
  autoFocus?: boolean
  inputRef?: Ref<HTMLInputElement>
  inputTestId?: string
  spellCheck?: boolean
  className?: string
  'aria-label'?: string
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
    hasMatches,
    status,
    options,
    onOptionChange,
    placeholder,
    labels,
    autoFocus = true,
    inputRef,
    inputTestId,
    spellCheck,
    className,
    'aria-label': ariaLabel,
    'data-testid': testId
  },
  ref
) {
  const t = useOptionalT()
  const hasQuery = value.length > 0
  const count = matchCount ?? null
  const empty = hasQuery && (count === 0 || (count == null && hasMatches === false))
  const counter =
    status ?? (hasQuery && count != null ? `${count === 0 ? 0 : (matchIndex ?? 0) + 1}/${count}` : null)
  const navDisabled = !hasQuery || empty
  const inputLabel = labels?.input ?? t('chat.find')
  return (
    <div
      ref={ref}
      role="search"
      aria-label={ariaLabel ?? inputLabel}
      className={cx('ui-findbar', className)}
      data-testid={testId}
      onKeyDown={(event) => {
        if (event.defaultPrevented || event.nativeEvent.isComposing) return
        if (event.key === 'F3') {
          event.preventDefault()
          event.stopPropagation()
          if (event.shiftKey) onPrevious()
          else onNext()
        } else if (event.key === 'Escape' && onClose) {
          event.preventDefault()
          event.stopPropagation()
          onClose()
        }
      }}
    >
      <RACTextField
        aria-label={inputLabel}
        value={value}
        onChange={onChange}
        autoFocus={autoFocus}
        className="ui-findbar__field"
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return
          if (event.key === 'Enter' || event.key === 'F3') {
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
          <InputGroupInput
            ref={inputRef}
            placeholder={placeholder ?? t('chat.findPlaceholder')}
            spellCheck={spellCheck}
            data-testid={inputTestId}
          />
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
                  data-testid={option.testId}
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
