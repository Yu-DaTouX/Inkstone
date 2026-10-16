import type { ReactElement, ReactNode } from 'react'
import { Button } from '../../../ui'

export interface SettingsRowProps {
  label: ReactNode
  description?: ReactNode
  block?: boolean
  children: ReactNode
}

export function SettingsRow({ label, description, block, children }: SettingsRowProps): ReactElement {
  return (
    <div className="settings-row" data-block={block ? '1' : '0'}>
      <div className="settings-row__text">
        <span className="settings-row__label">{label}</span>
        {description != null ? <span className="settings-row__desc">{description}</span> : null}
      </div>
      <div className="settings-row__ctl">{children}</div>
    </div>
  )
}

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  testId?: string
}

export interface SegmentedProps<T extends string> {
  label: string
  value: T
  options: readonly SegmentedOption<T>[]
  onChange: (value: T) => void
  disabled?: boolean
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled
}: SegmentedProps<T>): ReactElement {
  return (
    <div className="settings-seg" role="group" aria-label={label}>
      {options.map((option) => (
        <Button
          key={option.value}
          size="sm"
          variant={option.value === value ? 'primary' : 'secondary'}
          aria-pressed={option.value === value}
          isDisabled={disabled}
          data-testid={option.testId}
          onPress={() => onChange(option.value)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  )
}
