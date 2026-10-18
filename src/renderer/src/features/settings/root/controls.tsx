import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { useI18n } from '../../../i18n'
import { Button, SegmentedControl } from '../../../ui'
import { settingsText } from '../settings-text'
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
    <div
      className="settings-row"
      data-block={block ? '1' : '0'}
      data-nested={nested ? '1' : undefined}
      data-setting-id={settingId}
    >
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

export function SettingsMore({ label, children }: { label?: string; children: ReactNode }): ReactElement {
  const { lang } = useI18n()
  const text = settingsText(lang)
  const [open, setOpen] = useState(false)
  const body = useRef<HTMLDivElement>(null)
  const target = useSyncExternalStore(subscribeSettingReveal, getSettingReveal, getSettingReveal)
  useEffect(() => {
    if (target && body.current?.querySelector(settingSelector(target.id))) setOpen(true)
  }, [target])
  return (
    <section className="settings-more" data-open={open ? '1' : '0'}>
      <Button
        variant="ghost"
        size="sm"
        className="settings-more__toggle"
        aria-expanded={open}
        icon={<ChevronRight size={14} className="settings-more__chevron" />}
        onPress={() => setOpen((value) => !value)}
        data-testid="settings-more-toggle"
      >
        {label ?? text.moreSettings}
      </Button>
      <SettingsReveal open={open}>
        <div ref={body} className="settings-more__body">
          {children}
        </div>
      </SettingsReveal>
    </section>
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
