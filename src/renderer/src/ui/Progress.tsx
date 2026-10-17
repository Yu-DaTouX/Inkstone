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
  showValue?: boolean
}

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
  projectedPercent?: number | null
}

export function Meter({ label, showValue = false, projectedPercent, className, ...props }: MeterProps) {
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
            {projectedPercent != null && renderProps.percentage != null && projectedPercent > renderProps.percentage ? (
              <div
                className="ui-progress__projection"
                data-testid="ui-meter-projection"
                style={{ width: `${Math.min(100, projectedPercent)}%` }}
              />
            ) : null}
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
  label?: string
  size?: number
}

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
