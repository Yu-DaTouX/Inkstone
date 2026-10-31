import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactElement, type ReactNode } from 'react'
import { Button, CollapsibleChevron, cx, SegmentedControl, SettingRow, SettingSection } from '../../../ui'
import { getSettingReveal, settingSelector, subscribeSettingReveal } from '../search/search-model'

export interface SettingsRowProps {
  label: ReactNode
  description?: ReactNode
  block?: boolean
  nested?: boolean
  settingId?: string
  children: ReactNode
}

export function SettingsRow({ label, description, block, nested, settingId, children }: SettingsRowProps): ReactElement {
  return (
    <SettingRow
      className="settings-row"
      label={label}
      description={description}
      block={block}
      indent={nested}
      data-nested={nested ? '1' : undefined}
      data-setting-id={settingId}
    >
      {children}
    </SettingRow>
  )
}

export interface SettingsGroupProps {
  title?: ReactNode
  label?: string
  description?: ReactNode
  actions?: ReactNode
  plain?: boolean
  className?: string
  settingId?: string
  testId?: string
  children: ReactNode
}

export function SettingsGroup({
  title,
  label,
  description,
  actions,
  plain,
  className,
  settingId,
  testId,
  children
}: SettingsGroupProps): ReactElement {
  return (
    <SettingSection
      className={cx('settings-group', className)}
      title={title}
      description={description}
      actions={actions}
      plain={plain}
      aria-label={title == null ? label : undefined}
      data-setting-id={settingId}
      data-testid={testId}
    >
      {children}
    </SettingSection>
  )
}

export function SettingsReveal({ open, children }: { open: boolean; children: ReactNode }): ReactElement {
  return (
    <div className="settings-reveal" data-open={open ? '1' : '0'} data-setting-rows-continue="" inert={!open} aria-hidden={!open}>
      <div className="settings-reveal__inner">{children}</div>
    </div>
  )
}

export interface SettingsAdvancedProps {
  label: string
  testId?: string
  children: ReactNode
}

export function SettingsAdvanced({ label, testId, children }: SettingsAdvancedProps): ReactElement {
  const [open, setOpen] = useState(false)
  const body = useRef<HTMLDivElement>(null)
  const bodyId = useId()
  const reveal = useSyncExternalStore(subscribeSettingReveal, getSettingReveal, getSettingReveal)
  useEffect(() => {
    if (reveal && body.current?.querySelector(settingSelector(reveal.id))) setOpen(true)
  }, [reveal])
  return (
    <div className="settings-advanced" data-open={open ? '1' : '0'}>
      <Button
        variant="ghost"
        aria-expanded={open}
        aria-controls={bodyId}
        icon={<CollapsibleChevron expanded={open} />}
        data-testid={testId}
        onPress={() => setOpen((value) => !value)}
      >
        {label}
      </Button>
      <div className="settings-reveal" data-open={open ? '1' : '0'} inert={!open} aria-hidden={!open}>
        <div className="settings-reveal__inner">
          <div className="settings-advanced__body" id={bodyId} ref={body}>
            {children}
          </div>
        </div>
      </div>
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
