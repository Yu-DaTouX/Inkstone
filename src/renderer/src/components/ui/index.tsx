import { PulseField, resolveColor } from './pulse-field'
import {
  forwardRef,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes
} from 'react'
import { Icon, type IconName } from '../../icons/Icon'
import { APPEARANCE_EVENT } from '../../lib/appearance'
import { Tip } from './Tip'

export { Tip } from './Tip'
export { WheelPicker } from './WheelPicker'

type ButtonVariant = 'secondary' | 'primary' | 'ghost' | 'danger'
type ButtonSize = 'sm' | 'md' | 'lg'

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: IconName
  trailingIcon?: IconName
  block?: boolean
  active?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, trailingIcon, block, active, className, children, type, ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={cx(
        'btn',
        variant !== 'secondary' && variant,
        size !== 'md' && size,
        block && 'block',
        active && 'on',
        className
      )}
      {...(active !== undefined ? { 'aria-pressed': active } : {})}
      {...rest}
    >
      {icon ? <Icon name={icon} size={size === 'lg' ? 16 : 12} /> : null}
      {children !== undefined && children !== null ? <span>{children}</span> : null}
      {trailingIcon ? <Icon name={trailingIcon} size={12} /> : null}
    </button>
  )
})

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName
  label: string
  size?: ButtonSize
  iconSize?: 12 | 14 | 16
  iconClassName?: string
  active?: boolean
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, size = 'md', iconSize, iconClassName, active, className, type, title, ...rest },
  ref
) {
  const tip = typeof title === 'string' && title.trim() ? title : label
  return (
    <Tip label={tip}>
      <button
        ref={ref}
        type={type ?? 'button'}
        className={cx('btn icon', size !== 'md' && size, active && 'on', className)}
        aria-label={label}
        {...(active !== undefined ? { 'aria-pressed': active } : {})}
        {...rest}
      >
        <Icon name={icon} size={iconSize ?? (size === 'lg' ? 16 : size === 'sm' ? 12 : 14)} className={iconClassName} />
      </button>
    </Tip>
  )
})

export interface SegmentedOption<T extends string> {
  value: T
  label: ReactNode
  icon?: IconName
  disabled?: boolean
  testId?: string
  title?: string
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = 'md',
  label,
  className,
  testId
}: {
  options: Array<SegmentedOption<T>>
  value: T
  onChange: (value: T) => void
  size?: 'sm' | 'md'
  label?: string
  className?: string
  testId?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const root = ref.current
    const sel = root?.querySelector<HTMLElement>('.seg-btn.sel')
    if (!root || !sel) return
    root.style.setProperty('--seg-x', `${sel.offsetLeft}px`)
    root.style.setProperty('--seg-w', `${sel.offsetWidth}px`)
  })
  return (
    <div
      ref={ref}
      className={cx('seg sliding', size === 'sm' && 'sm', className)}
      role="group"
      aria-label={label}
      data-testid={testId}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={cx('seg-btn', option.value === value && 'sel')}
          aria-pressed={option.value === value}
          disabled={option.disabled}
          title={option.title}
          data-testid={option.testId}
          onClick={() => onChange(option.value)}
        >
          {option.icon ? <Icon name={option.icon} size={12} /> : null}
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
  testId
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
  testId?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={cx('switch-pill', checked && 'on')}
      disabled={disabled}
      data-testid={testId}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-knob" />
    </button>
  )
}

export type BadgeTone = 'neutral' | 'accent' | 'ok' | 'warn' | 'err'

export function Badge({
  tone = 'neutral',
  className,
  children,
  title,
  testId
}: {
  tone?: BadgeTone
  className?: string
  children: ReactNode
  title?: string
  testId?: string
}) {
  return (
    <span className={cx('ui-badge', tone !== 'neutral' && tone, className)} title={title} data-testid={testId}>
      {children}
    </span>
  )
}

export function LinkButton({ url, label, onOpen }: { url: string; label?: string; onOpen: (url: string) => void }) {
  const shown = url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')
  return (
    <button type="button" className="ui-link" title={url} onClick={() => onOpen(url)}>
      {label ? <span className="ui-link-kind">{label}</span> : null}
      <span className="ui-link-url">{shown}</span>
    </button>
  )
}

export function EmptyState({
  icon,
  title,
  children,
  action,
  center,
  className,
  testId
}: {
  icon?: IconName
  title?: ReactNode
  children?: ReactNode
  action?: ReactNode
  center?: boolean
  className?: string
  testId?: string
}) {
  return (
    <div className={cx('ui-empty', center && 'center', className)} data-testid={testId}>
      {icon ? <Icon name={icon} size={16} className="ui-empty-icon" /> : null}
      {title ? <div className="ui-empty-title">{title}</div> : null}
      {children ? <div>{children}</div> : null}
      {action ?? null}
    </div>
  )
}

export function SectionTitle({
  icon,
  children,
  className
}: {
  icon?: IconName
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cx('ui-section-title', className)}>
      {icon ? <Icon name={icon} size={12} /> : null}
      {children}
    </div>
  )
}

export function Spinner({ mute, className, label }: { mute?: boolean; className?: string; label?: string }) {
  return (
    <span
      className={cx('ui-spin', mute && 'mute', className)}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    />
  )
}

export function RunDot({ className, label }: { className?: string; label?: string }) {
  return (
    <span
      className={cx('ui-run-dot', className)}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    />
  )
}

export function Caret({ idle, className }: { idle?: boolean; className?: string }) {
  return <span className={cx('ui-caret', idle && 'idle', className)} aria-hidden />
}

export function Grow({
  open = true,
  enter,
  className,
  style,
  children
}: {
  open?: boolean
  enter?: boolean
  className?: string
  style?: CSSProperties
  children: ReactNode
}) {
  return (
    <div className={cx('ui-grow', !open && 'closed', enter && 'enter', className)} style={style} aria-hidden={!open} inert={!open}>
      <div>{children}</div>
    </div>
  )
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  numeric?: boolean
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ numeric, className, ...rest }, ref) {
  return <input ref={ref} className={cx('ui-input', numeric && 'num', className)} {...rest} />
})

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...rest }, ref) {
    return <textarea ref={ref} className={cx('ui-input', className)} {...rest} />
  }
)

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...rest },
  ref
) {
  return (
    <select ref={ref} className={cx('ui-input', className)} {...rest}>
      {children}
    </select>
  )
})

export function Field({
  label,
  hint,
  className,
  children
}: {
  label: ReactNode
  hint?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <label className={cx('ui-field', className)}>
      <span className="ui-field-label">{label}</span>
      {children}
      {hint ? <span className="ui-field-hint">{hint}</span> : null}
    </label>
  )
}

export function SettingGroup({
  title,
  className,
  children,
  ...rest
}: { title?: ReactNode; children: ReactNode } & HTMLAttributes<HTMLElement>) {
  return (
    <section className={cx('ui-group', className)} {...rest}>
      {title ? <h3 className="ui-group-title">{title}</h3> : null}
      {children}
    </section>
  )
}

export function Disclosure({
  title,
  defaultOpen,
  testId,
  children
}: {
  title: ReactNode
  defaultOpen?: boolean
  testId?: string
  children: ReactNode
}) {
  return (
    <details className="ui-disclosure" open={defaultOpen} data-testid={testId}>
      <summary>
        <Icon name="chevron-right" size={12} className="chev" />
        {title}
      </summary>
      <div className="ui-disclosure-body">{children}</div>
    </details>
  )
}

export function SettingRow({
  name,
  desc,
  col,
  ctlClassName,
  ctlProps,
  className,
  children,
  ...rest
}: {
  name?: ReactNode
  desc?: ReactNode
  col?: boolean
  ctlClassName?: string
  ctlProps?: HTMLAttributes<HTMLDivElement> & Record<`data-${string}`, string | undefined>
  children?: ReactNode
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx('ui-row', col && 'col', className)} {...rest}>
      {name !== undefined || desc !== undefined ? (
        <div className="ui-row-label">
          {name !== undefined ? <div className="ui-row-name">{name}</div> : null}
          {desc !== undefined ? <div className="ui-row-desc">{desc}</div> : null}
        </div>
      ) : null}
      {children !== undefined ? (
        <div className={cx('ui-row-ctl', ctlClassName)} {...ctlProps}>
          {children}
        </div>
      ) : null}
    </div>
  )
}

export interface TabItem<T extends string> {
  value: T
  label: ReactNode
  icon?: IconName
  testId?: string
  title?: string
  onClose?: () => void
  closeLabel?: string
}

export function Tabs<T extends string>({
  items,
  value,
  onChange,
  vertical,
  label,
  className,
  testId
}: {
  items: Array<TabItem<T>>
  value: T
  onChange: (value: T) => void
  vertical?: boolean
  label?: string
  className?: string
  testId?: string
}) {
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const next = vertical ? ['ArrowDown', 'ArrowUp'] : ['ArrowRight', 'ArrowLeft']
    const dir = event.key === next[0] ? 1 : event.key === next[1] ? -1 : 0
    if (!dir) return
    const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    const at = tabs.indexOf(document.activeElement as HTMLButtonElement)
    if (at < 0) return
    event.preventDefault()
    tabs[(at + dir + tabs.length) % tabs.length]?.focus()
  }
  return (
    <div
      className={cx('ui-tabs', vertical && 'vertical', className)}
      role="tablist"
      aria-label={label}
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      data-testid={testId}
      onKeyDown={onKeyDown}
    >
      {items.map((item) => (
        <Tab
          key={item.value}
          selected={item.value === value}
          icon={item.icon}
          testId={item.testId}
          title={item.title}
          onClick={() => onChange(item.value)}
          onClose={item.onClose}
          closeLabel={item.closeLabel}
        >
          {item.label}
        </Tab>
      ))}
    </div>
  )
}

function CloseButton({ closeLabel, onClose }: { closeLabel?: string; onClose: () => void }) {
  const span = (
    <span
      role="button"
      tabIndex={-1}
      className="ui-tab-close"
      aria-label={closeLabel}
      onClick={(event) => {
        event.stopPropagation()
        onClose()
      }}
    >
      <Icon name="close" size={12} />
    </span>
  )
  return closeLabel ? <Tip label={closeLabel}>{span}</Tip> : span
}

export function Tab({
  selected,
  icon,
  onClick,
  onClose,
  closeLabel,
  className,
  testId,
  title,
  children,
  onPointerDown
}: {
  selected: boolean
  icon?: IconName
  onClick: () => void
  onClose?: () => void
  closeLabel?: string
  className?: string
  testId?: string
  title?: string
  children: ReactNode
  onPointerDown?: React.PointerEventHandler<HTMLButtonElement>
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      className={cx('ui-tab', onClose && 'doc', selected && 'sel', className)}
      data-testid={testId}
      title={title}
      onClick={onClick}
      onPointerDown={onPointerDown}
    >
      {icon ? <Icon name={icon} size={12} /> : null}
      <span className="ui-tab-label">{children}</span>
      {onClose ? (
        <CloseButton closeLabel={closeLabel} onClose={onClose} />
      ) : null}
    </button>
  )
}

export const Menu = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & { label?: string }>(function Menu(
  { label, className, children, ...rest },
  ref
) {
  return (
    <div ref={ref} role="menu" aria-label={label} className={cx('ui-menu', className)} {...rest}>
      {children}
    </div>
  )
})

export interface MenuItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: IconName
  danger?: boolean
}

export const MenuItem = forwardRef<HTMLButtonElement, MenuItemProps>(function MenuItem(
  { icon, danger, className, children, type, ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      role="menuitem"
      className={cx('ui-menu-item', danger && 'danger', className)}
      {...rest}
    >
      {icon ? <Icon name={icon} size={12} /> : null}
      {children}
    </button>
  )
})

export function MenuSeparator() {
  return <div className="ui-menu-sep" role="separator" />
}

export function MiniMeter({
  percent,
  tone,
  title,
  className
}: {
  percent: number | null
  tone?: 'ok' | 'warn' | 'err' | ''
  title?: string
  className?: string
}) {
  const value = percent === null || !Number.isFinite(percent) ? null : Math.max(0, Math.min(100, percent))
  return (
    <span
      className={cx('ui-mini-meter', tone, value === null && 'unknown', className)}
      title={title}
      aria-hidden="true"
    >
      <i style={{ width: `${value ?? 0}%` }} />
    </span>
  )
}

export function InspectorSection({
  title,
  icon,
  summary,
  className,
  children,
  ...rest
}: {
  title: ReactNode
  icon?: IconName
  summary?: ReactNode
  children?: ReactNode
} & Omit<HTMLAttributes<HTMLElement>, 'title'>) {
  return (
    <section className={cx('ui-inspector-section', className)} {...rest}>
      <div className="ui-inspector-head">
        {icon ? <Icon name={icon} size={12} /> : null}
        <span>{title}</span>
        {summary !== undefined ? <span className="ui-inspector-summary">{summary}</span> : null}
      </div>
      {children}
    </section>
  )
}

export const ListRow = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { icon?: IconName; lead?: ReactNode; meta?: ReactNode; current?: boolean }
>(function ListRow({ icon, lead, meta, current, className, children, type, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={cx('ui-list-row', className)}
      aria-current={current || undefined}
      {...rest}
    >
      {lead ?? (icon ? <Icon name={icon} size={12} /> : null)}
      <span className="ui-list-row-main">{children}</span>
      {meta !== undefined ? <span className="ui-list-row-meta">{meta}</span> : null}
    </button>
  )
})

export function MiniRing({ percent, tone, size = 14 }: { percent: number | null; tone?: 'ok' | 'warn' | 'err' | ''; size?: number }) {
  const value = percent === null || !Number.isFinite(percent) ? 0 : Math.max(0, Math.min(100, percent))
  const r = (size - 3) / 2, c = 2 * Math.PI * r
  return (
    <svg className={cx('ui-mini-ring', tone, percent === null && 'unknown')} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle className="ui-mini-ring-track" cx={size / 2} cy={size / 2} r={r} />
      <circle className="ui-mini-ring-value" cx={size / 2} cy={size / 2} r={r} strokeDasharray={c} strokeDashoffset={c * (1 - value / 100)} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
    </svg>
  )
}

export function StepSlider<T extends string>({
  values,
  value,
  onChange,
  label,
  format,
  colorOf,
  disabled,
  testId,
  stopTestId,
  onPreview
}: {
  values: readonly T[]
  value: T
  onChange: (value: T) => void
  label: string
  format: (value: T) => string
  colorOf?: (value: T) => string
  disabled?: boolean
  testId?: string
  stopTestId?: (value: T) => string
  onPreview?: (value: T | null) => void
}) {
  const track = useRef<HTMLDivElement>(null)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const dragging = useRef(false)
  const n = values.length
  const index = Math.max(0, values.indexOf(value))
  const shown = dragIndex ?? index
  const at = (i: number): number => (n > 1 ? (i / (n - 1)) * 100 : 0)
  const pick = (clientX: number): number => {
    const rect = track.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0 || n < 2) return index
    return Math.round(Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * (n - 1))
  }
  const commit = (i: number): void => {
    const next = values[Math.max(0, Math.min(n - 1, i))]
    if (next !== undefined && next !== value) onChange(next)
  }
  useEffect(() => setDragIndex(null), [value])
  const preview = useRef(onPreview)
  preview.current = onPreview
  useEffect(() => { preview.current?.(dragIndex === null ? null : values[dragIndex] ?? null) }, [dragIndex, values])
  const root = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const probe = useRef<HTMLSpanElement>(null)
  const field = useRef<PulseField | null>(null)
  const palette = values.map((v) => colorOf?.(v) ?? 'var(--accent)').join('|')
  useEffect(() => {
    if (!canvas.current || !root.current || !probe.current) return
    const engine = new PulseField(canvas.current, root.current)
    field.current = engine
    const paint = (): void => {
      const el = probe.current
      if (!el) return
      engine.setColors({
        levels: palette.split('|').map((c) => resolveColor(el, c)),
        off: resolveColor(el, 'var(--bg-4)'),
        dark: document.documentElement.dataset.theme === 'dark'
      })
    }
    paint()
    const themes = new MutationObserver(paint)
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] })
    window.addEventListener(APPEARANCE_EVENT, paint)
    return () => { themes.disconnect(); window.removeEventListener(APPEARANCE_EVENT, paint); engine.dispose(); field.current = null }
  }, [palette])
  useEffect(() => { field.current?.setLevel(shown, n, !!disabled) }, [shown, n, disabled, palette])
  const style = {
    '--step-pct': `${at(shown)}%`,
    ...(colorOf ? { '--step-color': colorOf(values[shown]) } : {})
  } as CSSProperties
  return (
    <div ref={root} className={cx('ui-step-slider', dragIndex !== null && 'dragging', disabled && 'disabled')} style={style} data-testid={testId}>
      <span ref={probe} className="ui-step-probe" aria-hidden="true" />
      <div
        ref={track}
        className="ui-step-track"
        onPointerDown={(e) => {
          if (disabled || e.button !== 0) return
          e.preventDefault()
          try { e.currentTarget.setPointerCapture(e.pointerId) } catch { }
          dragging.current = true
          ;(e.currentTarget.querySelector('.ui-step-thumb') as HTMLElement | null)?.focus()
          setDragIndex(pick(e.clientX))
        }}
        onPointerMove={(e) => { if (dragging.current) setDragIndex(pick(e.clientX)) }}
        onPointerUp={(e) => { if (!dragging.current) return; dragging.current = false; const i = pick(e.clientX); setDragIndex(null); commit(i) }}
        onPointerCancel={() => { dragging.current = false; setDragIndex(null) }}
      >
        <canvas ref={canvas} className="ui-step-field" aria-hidden="true" data-lit={shown > 0 ? '1' : '0'} />
        <span
          className="ui-step-thumb"
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={n - 1}
          aria-valuenow={shown}
          aria-valuetext={format(values[shown])}
          aria-disabled={disabled || undefined}
          onKeyDown={(e) => {
            if (disabled) return
            const step = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0
            if (step) { e.preventDefault(); commit(index + step) }
            else if (e.key === 'Home') { e.preventDefault(); commit(0) }
            else if (e.key === 'End') { e.preventDefault(); commit(n - 1) }
          }}
        />
      </div>
      <div className="ui-step-labels">
        {values.map((v, i) => (
          <button
            key={v}
            type="button"
            tabIndex={-1}
            className={cx('ui-step-label', i === shown && 'on', i === 0 && 'first', i === n - 1 && 'last')}
            style={{ left: `${at(i)}%` }}
            disabled={disabled}
            onClick={() => commit(i)}
            data-testid={stopTestId?.(v)}
            data-level={v}
            data-on={i === index ? '1' : '0'}
          >
            {format(v)}
          </button>
        ))}
      </div>
    </div>
  )
}
