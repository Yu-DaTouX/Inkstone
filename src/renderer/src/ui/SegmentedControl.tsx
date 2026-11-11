import type { ReactElement, ReactNode } from 'react'
import { SelectionIndicator, ToggleButton, ToggleButtonGroup, type Key } from 'react-aria-components'
import { cx } from './cx'

export interface SegmentedControlOption<T extends string> {
  value: T
  label: string
  icon?: ReactNode
  title?: string
  testId?: string
  disabled?: boolean
}

export interface SegmentedControlProps<T extends string> {
  label: string
  value: T
  options: readonly SegmentedControlOption<T>[]
  onChange: (value: T) => void
  variant?: 'track' | 'plain'
  isDisabled?: boolean
  className?: string
}

export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  variant = 'track',
  isDisabled,
  className
}: SegmentedControlProps<T>): ReactElement {
  const select = (keys: Set<Key>): void => {
    const next = [...keys][0]
    if (next != null && next !== value) onChange(String(next) as T)
  }
  return (
    <ToggleButtonGroup
      aria-label={label}
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[value]}
      onSelectionChange={select}
      isDisabled={isDisabled}
      className={cx('ui-seg', className)}
      data-variant={variant === 'plain' ? 'plain' : undefined}
    >
      {options.map((option) => (
        <ToggleButton key={option.value} id={option.value} className="ui-seg__item" isDisabled={option.disabled} data-testid={option.testId}>
          <SelectionIndicator className="ui-seg__thumb" />
          {option.icon != null ? (
            <span className="ui-seg__icon" aria-hidden="true">
              {option.icon}
            </span>
          ) : null}
          <span className="ui-seg__label" data-text={option.label} title={option.title}>
            {option.label}
          </span>
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  )
}
