import type { ReactElement } from 'react'
import { SelectionIndicator, ToggleButton, ToggleButtonGroup, type Key } from 'react-aria-components'
import { cx } from './cx'

export interface SegmentedControlOption<T extends string> {
  value: T
  label: string
  testId?: string
}

export interface SegmentedControlProps<T extends string> {
  label: string
  value: T
  options: readonly SegmentedControlOption<T>[]
  onChange: (value: T) => void
  isDisabled?: boolean
  className?: string
}

export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
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
    >
      {options.map((option) => (
        <ToggleButton key={option.value} id={option.value} className="ui-seg__item" data-testid={option.testId}>
          <SelectionIndicator className="ui-seg__thumb" />
          <span className="ui-seg__label" data-text={option.label}>
            {option.label}
          </span>
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  )
}
