import type { ReactNode } from 'react'
import {
  Meter as RACMeter,
  ProgressBar as RACProgressBar,
  composeRenderProps,
  type MeterProps as RACMeterProps,
  type ProgressBarProps as RACProgressBarProps
} from 'react-aria-components'
import { cx } from './cx'
import { SPINNER_SIZE, type SpinnerSizeName } from './sizes'

export type { SpinnerSizeName }

export type ProgressTone = 'ink' | 'run' | 'ask' | 'fail' | 'muted'

export interface ProgressBarProps extends Omit<RACProgressBarProps, 'children'> {
  label?: ReactNode
  showValue?: boolean
  tone?: ProgressTone
}

export function ProgressBar({ label, showValue = false, tone = 'ink', className, ...props }: ProgressBarProps) {
  return (
    <RACProgressBar {...props} className={composeRenderProps(className, (cn) => cx('ui-progress', `ui-progress--${tone}`, cn))}>
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
  tone?: ProgressTone
}

export function Meter({ label, showValue = false, projectedPercent, tone = 'ink', className, ...props }: MeterProps) {
  return (
    <RACMeter {...props} className={composeRenderProps(className, (cn) => cx('ui-progress', 'ui-meter', `ui-progress--${tone}`, cn))}>
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

export interface MeterRingProps extends Omit<RACMeterProps, 'children'> {
  size?: number
  strokeWidth?: number
}

export function MeterRing({ size = 24, strokeWidth = 3, className, ...props }: MeterRingProps) {
  const center = size / 2
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  return (
    <RACMeter {...props} className={composeRenderProps(className, (cn) => cx('ui-meter-ring', cn))}>
      {({ percentage }) => (
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
          <circle className="ui-meter-ring__track" cx={center} cy={center} r={radius} strokeWidth={strokeWidth} fill="none" />
          {percentage > 0 ? (
            <circle
              className="ui-meter-ring__fill"
              cx={center}
              cy={center}
              r={radius}
              strokeWidth={strokeWidth}
              fill="none"
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - Math.min(100, percentage) / 100)}
              transform={`rotate(-90 ${center} ${center})`}
            />
          ) : null}
        </svg>
      )}
    </RACMeter>
  )
}

export interface SpinnerProps {
  className?: string
  label?: string
  size?: SpinnerSizeName | number
}

export function Spinner({ className, label, size: sizeProp = 'md' }: SpinnerProps) {
  const size = typeof sizeProp === 'number' ? sizeProp : SPINNER_SIZE[sizeProp]
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
