import { useMemo } from 'react'
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
  const shape = useMemo(() => {
    const max = niceCeil(points.reduce((top, point) => Math.max(top, point.value), 0))
    const span = Math.max(1, points.length - 1)
    const x = (i: number): number => (WIDTH * i) / span
    const y = (v: number): number => HEIGHT - (HEIGHT * Math.max(0, v)) / max
    const line = points.map((point, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(point.value).toFixed(1)}`).join(' ')
    const area = points.length ? `${line} L${x(points.length - 1).toFixed(1)} ${HEIGHT} L0 ${HEIGHT} Z` : ''
    const ticks = Array.from({ length: STEPS + 1 }, (_, i) => (max * i) / STEPS)
    return { line, area, ticks, x, y }
  }, [points])
  const labels = axisLabels ?? []
  const slot = WIDTH / Math.max(2, points.length)
  return (
    <div className={cx('ui-area-chart', className)} role="img" aria-label={props['aria-label']}>
      <div className="ui-area-chart__y" aria-hidden="true">
        {shape.ticks.map((tick) => (
          <span key={tick} className="ui-area-chart__axis">{tick ? formatValue(tick) : '0'}</span>
        ))}
      </div>
      <svg className="ui-area-chart__plot" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none">
        {shape.ticks.map((tick) => (
          <line key={tick} className="ui-area-chart__grid" x1={0} x2={WIDTH} y1={shape.y(tick)} y2={shape.y(tick)} />
        ))}
        {points.length > 1 ? (
          <>
            <path className="ui-area-chart__area" d={shape.area} />
            <path className="ui-area-chart__line" d={shape.line} />
          </>
        ) : null}
        {points.map((point, i) => (
          <rect key={point.key} className="ui-area-chart__hit" x={shape.x(i) - slot / 2} y={0} width={slot} height={HEIGHT}>
            <title>{point.title ?? `${point.key} · ${formatValue(point.value)}`}</title>
          </rect>
        ))}
      </svg>
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
