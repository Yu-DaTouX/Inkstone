import type { ReactElement, ReactNode } from 'react'
import { SegmentedControl } from '../../../ui'

export interface SettingsRowProps {
  label: ReactNode
  description?: ReactNode
  block?: boolean
  nested?: boolean
  children: ReactNode
}

export function SettingsRow({ label, description, block, nested, children }: SettingsRowProps): ReactElement {
  return (
    <div className="settings-row" data-block={block ? '1' : '0'} data-nested={nested ? '1' : undefined}>
      <div className="settings-row__text">
        <span className="settings-row__label">{label}</span>
        {description != null ? <span className="settings-row__desc">{description}</span> : null}
      </div>
      <div className="settings-row__ctl">{children}</div>
    </div>
  )
}

export function SettingsGroup({ label, children }: { label?: string; children: ReactNode }): ReactElement {
  return (
    <div className="settings-group" role="group" aria-label={label}>
      {children}
    </div>
  )
}

export function SettingsReveal({ open, children }: { open: boolean; children: ReactNode }): ReactElement {
  return (
    <div className="settings-reveal" data-open={open ? '1' : '0'} inert={!open} aria-hidden={!open}>
      <div className="settings-reveal__inner">{children}</div>
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
  return <SegmentedControl label={label} value={value} options={options} onChange={onChange} isDisabled={disabled} />
}
