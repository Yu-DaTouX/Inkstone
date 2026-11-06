import { useMemo, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'
import { cx } from './cx'
import './AreaChart.css'

export interface AreaChartPoint {
  key: string
  value: number
  title?: string
}

export interface AreaChartProps {
  points: readonly AreaChartPoint[]
  formatValue: (value: number) => string
  axisLabels?: readonly string[]
  'aria-label': string
  className?: string
}

const WIDTH = 436
const HEIGHT = 168
const STEPS = 4

function niceCeil(value: number): number {
  if (value <= 0) return 1
  const exp = 10 ** Math.floor(Math.log10(value))
  const unit = [1, 2, 2.5, 5, 10].find((step) => step * exp >= value) ?? 10
  return unit * exp
}

export function AreaChart({ points, formatValue, axisLabels, className, ...props }: AreaChartProps) {
  const [active, setActive] = useState<number | null>(null)
  const shape = useMemo(() => {
    const max = niceCeil(points.reduce((top, point) => Math.max(top, point.value), 0))
    const span = Math.max(1, points.length - 1)
    const x = (i: number): number => (WIDTH * i) / span
    const y = (v: number): number => HEIGHT - (HEIGHT * Math.max(0, v)) / max
    const line = points.map((point, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(point.value).toFixed(1)}`).join(' ')
    const area = points.length ? `${line} L${x(points.length - 1).toFixed(1)} ${HEIGHT} L0 ${HEIGHT} Z` : ''
    const ticks = Array.from({ length: STEPS + 1 }, (_, i) => (max * i) / STEPS)
    return { line, area, ticks, x, y, span }
  }, [points])
  const labels = axisLabels ?? []
  const last = points.length - 1
  const current = active !== null && active <= last ? points[active] : null
  const pick = (event: PointerEvent<HTMLDivElement>): void => {
    if (last < 0) return
    const box = event.currentTarget.getBoundingClientRect()
    const ratio = box.width > 0 ? (event.clientX - box.left) / box.width : 0
    setActive(Math.min(last, Math.max(0, Math.round(ratio * shape.span))))
  }
  const step = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (last < 0) return
    const from = active ?? last
    const next = event.key === 'ArrowLeft' ? from - 1 : event.key === 'ArrowRight' ? from + 1 : event.key === 'Home' ? 0 : event.key === 'End' ? last : null
    if (next === null) return
    event.preventDefault()
    setActive(Math.min(last, Math.max(0, next)))
  }
  const marker = current && active !== null
    ? ({
        '--chart-x': `${(shape.x(active) / WIDTH) * 100}%`,
        '--chart-y': `${(shape.y(current.value) / HEIGHT) * 100}%`,
        '--chart-shift': active === 0 ? '0%' : active === last ? '-100%' : '-50%'
      } as CSSProperties)
    : undefined
  return (
    <div className={cx('ui-area-chart', className)} role="group" aria-label={props['aria-label']}>
      <div className="ui-area-chart__y" aria-hidden="true">
        {shape.ticks.map((tick) => (
          <span key={tick} className="ui-area-chart__axis">{tick ? formatValue(tick) : '0'}</span>
        ))}
      </div>
      <div
        className="ui-area-chart__box"
        style={marker}
        tabIndex={points.length ? 0 : undefined}
        aria-label={props['aria-label']}
        onPointerMove={pick}
        onPointerLeave={() => setActive(null)}
        onFocus={() => setActive((value) => value ?? (last >= 0 ? last : null))}
        onBlur={() => setActive(null)}
        onKeyDown={step}
      >
        <svg className="ui-area-chart__plot" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
          {shape.ticks.map((tick) => (
            <line key={tick} className="ui-area-chart__grid" x1={0} x2={WIDTH} y1={shape.y(tick)} y2={shape.y(tick)} />
          ))}
          {points.length > 1 ? (
            <>
              <path className="ui-area-chart__area" d={shape.area} />
              <path className="ui-area-chart__line" d={shape.line} />
            </>
          ) : null}
          {current && active !== null ? <line className="ui-area-chart__marker" x1={shape.x(active)} x2={shape.x(active)} y1={0} y2={HEIGHT} /> : null}
        </svg>
        {current ? <span className="ui-area-chart__dot" aria-hidden="true" /> : null}
        <span className={cx('ui-area-chart__readout', current && 'ui-tip-surface')} aria-live="polite">
          {current ? current.title ?? `${current.key} · ${formatValue(current.value)}` : ''}
        </span>
      </div>
      {labels.length ? (
        <div className="ui-area-chart__x" aria-hidden="true">
          {labels.map((label, i) => (
            <span key={`${label}-${i}`} className="ui-area-chart__axis">{label}</span>
          ))}
        </div>
      ) : null}
    </div>
  )
}
