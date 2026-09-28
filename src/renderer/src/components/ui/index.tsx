import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Icon, type IconName } from '../../icons/Icon'

/**
 * 统一控件（v0.4）。外观唯一来源是 `styles/ui.css`；这里只把常用组合收成组件，
 * 让调用点写意图（主要 / 次要 / 无框 / 危险、尺寸、图标），不再各自拼类名。
 *
 * 组件不吞掉调用方的 className：模块可以继续加自己的版面类或探针钩子。
 */

type ButtonVariant = 'secondary' | 'primary' | 'ghost' | 'danger'
type ButtonSize = 'sm' | 'md' | 'lg'

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: IconName
  /** 图标放在文字之后（例如「打开 ›」） */
  trailingIcon?: IconName
  block?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, trailingIcon, block, className, children, type, ...rest },
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
        className
      )}
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
  /** 必填：图标按钮没有可见文字，名称同时用作 title 与无障碍名称 */
  label: string
  size?: ButtonSize
  active?: boolean
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, size = 'md', active, className, type, ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={cx('btn icon', size !== 'md' && size, active && 'on', className)}
      title={label}
      aria-label={label}
      {...(active !== undefined ? { 'aria-pressed': active } : {})}
      {...rest}
    >
      <Icon name={icon} size={size === 'lg' ? 16 : 14} />
    </button>
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

/** 互斥选项：主题、语言、视图切换。选中项用抬高一级的底色表达。 */
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
  /** 分组的无障碍名称 */
  label?: string
  className?: string
  testId?: string
}) {
  return (
    <div className={cx('seg', size === 'sm' && 'sm', className)} role="group" aria-label={label} data-testid={testId}>
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

/** 布尔开关：外观为 ui.css 的 .switch-pill，语义是 role="switch" */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
  testId
}: {
  checked: boolean
  onChange: (next: boolean) => void
  /** 无障碍名称（开关旁边通常已有可见标题，这里给读屏用） */
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

/** 空状态：一句事实 + 可选的下一步。不画插图，不写「暂无数据」式的空话。 */
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
