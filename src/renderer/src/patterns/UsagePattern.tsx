import type { ReactNode } from 'react'
import { SegmentedControl, Tab, TabList, Tabs } from '../ui'
import './usage-pattern.css'

export interface UsageToggleProps {
  kind: 'tab' | 'range'
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string) => void
  label: string
  testId?: string
}

export type UsageToggleRenderer = (props: UsageToggleProps) => ReactNode

export const renderUsageToggle: UsageToggleRenderer = ({
  kind,
  value,
  options,
  onChange,
  label,
  testId
}: UsageToggleProps): ReactNode =>
  kind === 'range' ? (
    <div className="usage-switch" data-usage-control={kind} data-testid={testId}>
      <SegmentedControl label={label} value={value} options={options} onChange={onChange} />
    </div>
  ) : (
    <Tabs
      className="usage-switch"
      selectedKey={value}
      onSelectionChange={(key) => onChange(String(key))}
      data-usage-control={kind}
      data-testid={testId}
    >
      <TabList className="usage-switch-list" aria-label={label}>
        {options.map((o) => (
          <Tab key={o.value} id={o.value}>
            {o.label}
          </Tab>
        ))}
      </TabList>
    </Tabs>
  )
