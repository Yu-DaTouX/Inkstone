import type { JSX, ReactNode } from 'react'
import { SegmentedControl, Tab, TabList, Tabs } from '../ui'
import { UsageOverview } from '../features/usage/UsageOverview'
import type { UsageToggleProps, UsageToggleRenderer } from '../features/usage/UsageOverviewView'
import './usage-pattern.css'
import { useUiV3 } from '../state/ui-v3'

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

export function UsagePattern({ emptyNote }: { emptyNote?: string } = {}): JSX.Element {
  return <UsageOverview compact renderToggle={renderUsageToggle} keepWhenEmpty emptyNote={emptyNote} onOpenDetails={() => useUiV3.getState().navigate({ name: 'usage' })} />
}
