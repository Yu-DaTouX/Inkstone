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
  /** 切换按钮的「已开启」：.on + aria-pressed */
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
  /** 必填：图标按钮没有可见文字，名称同时用作 title 与无障碍名称 */
  label: string
  size?: ButtonSize
  /** 图标尺寸默认随按钮：sm 12 · md 14 · lg 16 */
  iconSize?: 12 | 14 | 16
  /** 图标自身的类（如会旋转的 chevron） */
  iconClassName?: string
  active?: boolean
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, size = 'md', iconSize, iconClassName, active, className, type, ...rest },
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
      <Icon name={icon} size={iconSize ?? (size === 'lg' ? 16 : size === 'sm' ? 12 : 14)} className={iconClassName} />
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

/**
 * 互斥选项：主题、语言、视图切换。选中项用抬高一级的底色表达，
 * 切换时底块沿横向滑到新位置（motion.css 的 .seg.sliding，设计规范 §3.2）。
 */
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
  const ref = useRef<HTMLDivElement>(null)
  /* 量选中项的位置写进 CSS 变量；底块本身由 ::before 画，不占 DOM */
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

/**
 * 进行中：方点阵（motion.css 的 .ui-spin）。只挂在真实运行的状态上，
 * 旁边要有文字或无障碍名称说明在做什么 —— 动画不能是唯一的状态信息。
 */
export function Spinner({ mute, className, label }: { mute?: boolean; className?: string; label?: string }) {
  return (
    <span
      className={cx('ui-spin', mute && 'mute', className)}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    />
  )
}

/**
 * 进行中的静态标记：强调色方点。同一时刻界面上只有一个方点阵（当前会话运行时
 * 在输入区运行条）；工具行、任务、左栏、推理头等次要位置用它，避免多处同时在转。
 */
export function RunDot({ className, label }: { className?: string; label?: string }) {
  return (
    <span
      className={cx('ui-run-dot', className)}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    />
  )
}

/** 流式输出的光标：输出中常亮，停下后闪烁 */
export function Caret({ idle, className }: { idle?: boolean; className?: string }) {
  return <span className={cx('ui-caret', idle && 'idle', className)} aria-hidden />
}

/**
 * 展开 / 收起：0fr ↔ 1fr 的网格行过渡，内容被连续推开。
 * `enter` 用于新插入的块（首帧就长出来）；收合用 `open`。
 */
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
    <div className={cx('ui-grow', !open && 'closed', enter && 'enter', className)} style={style} aria-hidden={!open}>
      <div>{children}</div>
    </div>
  )
}

/* ------------------------------------------------------------------ 表单 */

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** 数值：96px、等宽数字、右对齐 */
  numeric?: boolean
}

/** 单行输入。外观来自 ui.css 的 .ui-input；宽度由所在版面决定时模块再写 width / flex */
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

/** 表单一项：标签 + 控件 + 说明。用 <label> 包住，点标签即聚焦控件 */
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

/**
 * 设置分组：页内的一组设置，带一行淡色小标题（设计规范 §5）。
 * 内容通常是一个 `.ui-rows`；合并后的设置页用它区分原来的几页。
 */
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

/**
 * 折叠披露：低频的高级选项与诊断默认收起，点标题展开（原生 details，键盘可用）。
 */
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

/**
 * 设置行：「名称 + 说明｜控件」。行本身不可点，也不响应悬停。
 * `col` 用于进度条、列表这类要占满宽的内容（上下排布）。
 */
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
  /** 控件格上的属性（data-testid、aria-label 等） */
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

/* ------------------------------------------------------------------ 页签 */

export interface TabItem<T extends string> {
  value: T
  label: ReactNode
  icon?: IconName
  testId?: string
  title?: string
  /** 有它就是可关闭的文档页签 */
  onClose?: () => void
  closeLabel?: string
}

/**
 * 页签：role=tablist，方向键在页签间移动焦点（竖排用上下，横排用左右）。
 * 选中项 --bg-3 底 + 强调色图标，与分段控件同一语言。
 */
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

/** 单个页签；列表需要自定义内容（拖动、计数）时直接用它，外面自己包 role=tablist */
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
        <span
          role="button"
          tabIndex={-1}
          className="ui-tab-close"
          aria-label={closeLabel}
          title={closeLabel}
          onClick={(event) => {
            event.stopPropagation()
            onClose()
          }}
        >
          <Icon name="close" size={12} />
        </span>
      ) : null}
    </button>
  )
}

/* ------------------------------------------------------------------ 菜单 */

/** 菜单容器（定位由调用方负责：右键菜单 fixed、下拉贴触发器） */
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

/* ------------------------------------------------------------------ 检查器与列表 */

/**
 * 检查器摘要里的迷你用量条：固定宽度，数字写在它左边，条本身不写字。
 * percent 为 null 表示用量未知（画成空槽，不画成 0%）；超过 100 只夹取宽度。
 */
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
      title={title ?? (value === null ? '用量未知' : `已用 ${percent!.toFixed(1)}%`)}
      aria-hidden="true"
    >
      <i style={{ width: `${value ?? 0}%` }} />
    </span>
  )
}

/** 检查器分区：标题 + 右侧摘要 + 内容。分区之间只有一条细线 */
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

/** 可点的一行：左侧图标或状态点、主文字截断、右侧元数据 */
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

/**
 * 小圆环：输入框里的上下文占用。percent 为 null 画空环；tone 只在黄 / 红档染色。
 * 数字写在环右侧，环本身不写字。
 */
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

/**
 * 分档滑块：轨道按档位等分，填充与手柄跟随当前档；拖动时逐档吸附，松手才提交。
 * 不用原生 range：它的外观在 Electron 里不可控，档位名也没法对齐刻度。
 */
export function StepSlider<T extends string>({
  values,
  value,
  onChange,
  label,
  format,
  colorOf,
  disabled,
  testId,
  stopTestId
}: {
  values: readonly T[]
  value: T
  onChange: (value: T) => void
  label: string
  format: (value: T) => string
  /** 当前档的颜色（CSS 值），填充、手柄与当前档名共用 */
  colorOf?: (value: T) => string
  disabled?: boolean
  testId?: string
  stopTestId?: (value: T) => string
}) {
  const track = useRef<HTMLDivElement>(null)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  /** Read by the pointer handlers directly: down and up can arrive before a re-render. */
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
  /* 外部值变化（别处切档）时放弃未提交的拖动 */
  useEffect(() => setDragIndex(null), [value])
  const style = { '--step-pct': `${at(shown)}%`, ...(colorOf ? { '--step-color': colorOf(values[shown]) } : {}) } as CSSProperties
  return (
    <div className={cx('ui-step-slider', dragIndex !== null && 'dragging', disabled && 'disabled')} style={style} data-testid={testId}>
      <div
        ref={track}
        className="ui-step-track"
        onPointerDown={(e) => {
          if (disabled || e.button !== 0) return
          e.preventDefault()
          try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* synthetic or already released pointer */ }
          dragging.current = true
          ;(e.currentTarget.querySelector('.ui-step-thumb') as HTMLElement | null)?.focus()
          setDragIndex(pick(e.clientX))
        }}
        onPointerMove={(e) => { if (dragging.current) setDragIndex(pick(e.clientX)) }}
        onPointerUp={(e) => { if (!dragging.current) return; dragging.current = false; const i = pick(e.clientX); setDragIndex(null); commit(i) }}
        onPointerCancel={() => { dragging.current = false; setDragIndex(null) }}
      >
        {/* One shared dot mask keeps the travelling highlight aligned across level bands. */}
        <div className="ui-step-dots" aria-hidden="true" data-lit={shown > 0 ? '1' : '0'}>
          {values.slice(1).map((v, i) => (
            <span
              key={v}
              className={cx('ui-step-seg', i < shown && 'on')}
              style={{ left: `${at(i)}%`, width: `${at(1)}%`, '--seg-from': colorOf?.(values[i]) ?? 'var(--accent)', '--seg-color': colorOf?.(v) ?? 'var(--accent)', '--seg-i': i < shown ? i : n - 2 - i } as CSSProperties}
            />
          ))}
          <span className="ui-step-wave" />
        </div>
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
        >
          {dragIndex !== null ? <span className="ui-step-bubble" aria-hidden>{format(values[shown])}</span> : null}
        </span>
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
