/**
 * 设置页内部共用的版面组合（feature 层）。
 *
 * 只做「标签 + 说明 + 控件」的布局与分段按钮的组合，控件外观本身仍来自
 * `ui/`（`Button` / `Switch`）。不新增 design token，间距/字号全部引用既有变量。
 */
import type { ReactElement, ReactNode } from 'react'
import { Button } from '../../../ui'

export interface SettingsRowProps {
  label: ReactNode
  description?: ReactNode
  /** 控件放在标签右侧还是下方；默认右侧。 */
  block?: boolean
  children: ReactNode
}

/** 一行设置：左侧标签与说明，右侧（或下方）控件。 */
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
  /** 给验收探针的稳定 id；同一组内唯一。 */
  testId?: string
}

export interface SegmentedProps<T extends string> {
  label: string
  value: T
  options: readonly SegmentedOption<T>[]
  onChange: (value: T) => void
  disabled?: boolean
}

/**
 * 分段选择：一组互斥短选项。用 `Button` 的 `aria-pressed` 表达选中，
 * 不引入新的控件外观；密度 / 字体这类 2–4 项选择直接用它。
 */
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
