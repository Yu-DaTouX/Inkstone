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

const WIDTH = 480
const HEIGHT = 200
const LEFT = 44
const TOP = 8
const BOTTOM = 176
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
    const x = (i: number): number => LEFT + ((WIDTH - LEFT) * i) / span
    const y = (v: number): number => BOTTOM - ((BOTTOM - TOP) * Math.max(0, v)) / max
    const line = points.map((point, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(point.value).toFixed(1)}`).join(' ')
    const area = points.length ? `${line} L${x(points.length - 1).toFixed(1)} ${BOTTOM} L${LEFT} ${BOTTOM} Z` : ''
    const ticks = Array.from({ length: STEPS + 1 }, (_, i) => (max * i) / STEPS)
    return { line, area, ticks, x, y }
  }, [points])
  const labels = axisLabels ?? []
  return (
    <svg className={cx('ui-area-chart', className)} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={props['aria-label']}>
      {shape.ticks.map((tick) => (
        <g key={tick}>
          <line className="ui-area-chart__grid" x1={LEFT} x2={WIDTH} y1={shape.y(tick)} y2={shape.y(tick)} />
          <text className="ui-area-chart__axis" x={LEFT - 6} y={shape.y(tick) + 3} textAnchor="end">{tick ? formatValue(tick) : '0'}</text>
        </g>
      ))}
      {points.length > 1 ? (
        <>
          <path className="ui-area-chart__area" d={shape.area} />
          <path className="ui-area-chart__line" d={shape.line} />
        </>
      ) : null}
      {points.map((point, i) => (
        <rect key={point.key} className="ui-area-chart__hit" x={shape.x(i) - (WIDTH - LEFT) / Math.max(2, points.length) / 2} y={TOP} width={(WIDTH - LEFT) / Math.max(2, points.length)} height={BOTTOM - TOP}>
          <title>{point.title ?? `${point.key} · ${formatValue(point.value)}`}</title>
        </rect>
      ))}
      {labels.map((label, i) => (
        <text
          key={`${label}-${i}`}
          className="ui-area-chart__axis"
          x={labels.length > 1 ? LEFT + ((WIDTH - LEFT) * i) / (labels.length - 1) : LEFT}
          y={BOTTOM + 18}
          textAnchor={i === 0 ? 'start' : i === labels.length - 1 ? 'end' : 'middle'}
        >
          {label}
        </text>
      ))}
    </svg>
  )
}
