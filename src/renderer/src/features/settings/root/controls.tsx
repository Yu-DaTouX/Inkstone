import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactElement, type ReactNode } from 'react'
import { Button, CollapsibleChevron, cx, IconButton, SegmentedControl, SettingRow, SettingSection, Slider } from '../../../ui'
import { RotateCcw } from '../../../ui/icons'
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
  fold?: { summary?: ReactNode }
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
  fold,
  children
}: SettingsGroupProps): ReactElement {
  const [open, setOpen] = useState(false)
  const body = useRef<HTMLDivElement>(null)
  const bodyId = useId()
  const reveal = useSyncExternalStore(subscribeSettingReveal, getSettingReveal, getSettingReveal)
  useEffect(() => {
    if (!fold || !reveal) return
    if (reveal.id === settingId || body.current?.querySelector(settingSelector(reveal.id))) setOpen(true)
  }, [fold, reveal, settingId])
  if (fold) {
    return (
      <SettingSection
        className={cx('settings-group', 'settings-fold', className)}
        variant="group"
        title={
          <Button
            variant="ghost"
            className="settings-fold__toggle"
            aria-expanded={open}
            aria-controls={bodyId}
            icon={<CollapsibleChevron expanded={open} />}
            data-testid={testId ? `${testId}-toggle` : undefined}
            onPress={() => setOpen((value) => !value)}
          >
            <span className="settings-fold__title">{title}</span>
            {fold.summary != null ? <span className="settings-fold__summary">{fold.summary}</span> : null}
          </Button>
        }
        plain
        data-setting-id={settingId}
        data-testid={testId}
      >
        <div className="settings-reveal" data-open={open ? '1' : '0'} inert={!open} aria-hidden={!open}>
          <div className="settings-reveal__inner">
            <div className="settings-fold__body" id={bodyId} ref={body}>
              {description != null ? <p className="ui-setting-section__desc">{description}</p> : null}
              {plain ? children : <div className="ui-setting-rows">{children}</div>}
            </div>
          </div>
        </div>
      </SettingSection>
    )
  }
  return (
    <SettingSection
      className={cx('settings-group', className)}
      variant="group"
      card
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

export interface SettingsRangeProps {
  label: string
  value: number
  min: number
  max: number
  step: number
  format: (value: number) => string
  formatOptions?: Intl.NumberFormatOptions
  unit?: RangeUnit
  onChange: (value: number) => void
  onChangeEnd?: (value: number) => void
  disabled?: boolean
  reset?: { label: string; onPress: () => void; disabled?: boolean; testId?: string }
  testId?: string
}

const firstValue = (value: number | number[]): number => (Array.isArray(value) ? value[0] ?? 0 : value)

export type RangeUnit = 'fraction' | 'percent' | 'ms' | 'px'

const UNIT_FORMAT: Record<Exclude<RangeUnit, 'px'>, Intl.NumberFormatOptions> = {
  fraction: { style: 'percent' },
  percent: { style: 'unit', unit: 'percent' },
  ms: { style: 'unit', unit: 'millisecond' }
}

export function SettingsRange({
  label,
  value,
  min,
  max,
  step,
  format,
  formatOptions,
  unit,
  onChange,
  onChangeEnd,
  disabled,
  reset,
  testId
}: SettingsRangeProps): ReactElement {
  const options = formatOptions ?? (unit && unit !== 'px' ? UNIT_FORMAT[unit] : undefined)
  return (
    <div className="settings-range" data-disabled={disabled ? '1' : undefined} data-ui-row-fill>
      {reset ? (
        <IconButton
          size="sm"
          className="settings-range__reset"
          aria-label={reset.label}
          tooltip={reset.label}
          isDisabled={reset.disabled}
          onPress={reset.onPress}
          data-testid={reset.testId}
        >
          <RotateCcw size={13} aria-hidden />
        </IconButton>
      ) : null}
      <Slider
        className="settings-range__slider"
        aria-label={unit === 'px' ? `${label} (px)` : label}
        minValue={min}
        maxValue={max}
        step={step}
        value={value}
        formatOptions={options}
        isDisabled={disabled}
        onChange={(next) => onChange(firstValue(next))}
        onChangeEnd={onChangeEnd ? (next) => onChangeEnd(firstValue(next)) : undefined}
        data-testid={testId}
      />
      <output className="settings-range__value ui-num" aria-hidden>
        {format(value)}
      </output>
    </div>
  )
}

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  testId?: string
  disabled?: boolean
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
