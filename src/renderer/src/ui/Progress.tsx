import type { ReactNode } from 'react'
import {
  Meter as RACMeter,
  ProgressBar as RACProgressBar,
  composeRenderProps,
  type MeterProps as RACMeterProps,
  type ProgressBarProps as RACProgressBarProps
} from 'react-aria-components'
import { cx } from './cx'

export interface ProgressBarProps extends Omit<RACProgressBarProps, 'children'> {
  label?: ReactNode
  /** 右侧显示同 RAC 的 `valueText`（百分比或自定义）。 */
  showValue?: boolean
}

/**
 * 进度条。`value` / `minValue` / `maxValue` 决定比例；不传 `value` 即不确定进度
 * （CSS 用循环动画表达，`prefers-reduced-motion` 下改为静止）。
 * 「已经用掉多少」这类静态量用 `Meter`，不要用进度条。
 */
export function ProgressBar({ label, showValue = false, className, ...props }: ProgressBarProps) {
  return (
    <RACProgressBar {...props} className={composeRenderProps(className, (cn) => cx('ui-progress', cn))}>
      {(renderProps) => (
        <>
          {label != null || showValue ? (
            <div className="ui-progress__head">
              {label != null ? <span className="ui-progress__label">{label}</span> : <span />}
              {showValue && renderProps.valueText ? (
                <span className="ui-progress__value">{renderProps.valueText}</span>
              ) : null}
            </div>
          ) : null}
          <div className="ui-progress__track">
            <div
              className="ui-progress__fill"
              style={renderProps.percentage != null ? { width: `${renderProps.percentage}%` } : undefined}
            />
          </div>
        </>
      )}
    </RACProgressBar>
  )
}

export interface MeterProps extends Omit<RACMeterProps, 'children'> {
  label?: ReactNode
  showValue?: boolean
}

/** 静态量的条形计量（例如上下文占用、磁盘用量）。 */
export function Meter({ label, showValue = false, className, ...props }: MeterProps) {
  return (
    <RACMeter {...props} className={composeRenderProps(className, (cn) => cx('ui-progress', 'ui-meter', cn))}>
      {(renderProps) => (
        <>
          {label != null || showValue ? (
            <div className="ui-progress__head">
              {label != null ? <span className="ui-progress__label">{label}</span> : <span />}
              {showValue && renderProps.valueText ? (
                <span className="ui-progress__value">{renderProps.valueText}</span>
              ) : null}
            </div>
          ) : null}
          <div className="ui-progress__track">
            <div
              className="ui-progress__fill"
              style={renderProps.percentage != null ? { width: `${renderProps.percentage}%` } : undefined}
            />
          </div>
        </>
      )}
    </RACMeter>
  )
}

export interface SpinnerProps {
  className?: string
  /** 读屏名称；不传则视为装饰（`aria-hidden`）。 */
  label?: string
  size?: number
}

/** 转圈。按钮里的 pending 由按钮自己的 `[data-pending]` 处理，这里用于独立加载块。 */
export function Spinner({ className, label, size = 16 }: SpinnerProps) {
  return (
    <span
      className={cx('ui-spinner', className)}
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ width: size, height: size }}
    />
  )
}
