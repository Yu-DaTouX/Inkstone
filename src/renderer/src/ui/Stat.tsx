import type { CSSProperties, HTMLAttributes, ReactNode } from 'react'
import { cx } from './cx'
import './Stat.css'

export interface StatGridProps extends HTMLAttributes<HTMLDListElement> {
  columns?: number
}

export function StatGrid({ columns = 2, className, style, ...rest }: StatGridProps) {
  return (
    <dl
      {...rest}
      className={cx('ui-stat-grid', className)}
      style={{ ...style, '--ui-stat-cols': columns } as CSSProperties}
    />
  )
}

export interface StatProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  label: ReactNode
  value: ReactNode
  unit?: ReactNode
  span?: number
  aside?: ReactNode
  footer?: ReactNode
}

export function Stat({ label, value, unit, span, aside, footer, className, style, ...rest }: StatProps) {
  return (
    <div
      {...rest}
      className={cx('ui-stat', className)}
      style={span && span > 1 ? { ...style, gridColumn: `span ${span}` } : style}
    >
      <dt className="ui-stat__label">{label}</dt>
      <dd className="ui-stat__value">
        <span className="ui-stat__num">{value}</span>
        {unit != null ? <span className="ui-stat__unit">{unit}</span> : null}
      </dd>
      {aside != null ? <dd className="ui-stat__aside">{aside}</dd> : null}
      {footer != null ? <dd className="ui-stat__footer">{footer}</dd> : null}
    </div>
  )
}

export interface MiniBarsProps {
  values: readonly number[]
  className?: string
}

export function MiniBars({ values, className }: MiniBarsProps) {
  const max = values.reduce((top, v) => (v > top ? v : top), 0)
  return (
    <span className={cx('ui-minibars', className)} aria-hidden="true">
      {values.map((v, i) => (
        <span
          key={i}
          className="ui-minibars__bar"
          data-last={i === values.length - 1 ? '1' : undefined}
          style={{ height: `${max > 0 ? Math.max(12, Math.round((v / max) * 100)) : 12}%` }}
        />
      ))}
    </span>
  )
}
