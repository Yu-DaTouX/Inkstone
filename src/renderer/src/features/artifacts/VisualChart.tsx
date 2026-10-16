import { useMemo, type CSSProperties, type JSX } from 'react'
import { useT } from '../../i18n'
import { niceScale, type ChartBlock } from '../../../../shared/visual-blocks'

const SERIES_COLORS = ['var(--data-1)', 'var(--data-2)', 'var(--data-3)', 'var(--data-4)'] as const

function seriesColor(index: number): string {
  return SERIES_COLORS[index % SERIES_COLORS.length]
}

export function fmtValue(value: number, unit?: string): string {
  const text = Number.isInteger(value) ? String(value) : value.toFixed(Math.abs(value) < 10 ? 2 : 1).replace(/\.?0+$/, '')
  return unit ? `${text}${unit === '%' ? '%' : ` ${unit}`}` : text
}

function ChartTable({ block }: { block: ChartBlock }): JSX.Element {
  return (
    <div className="v3-md-table-wrap">
      <table className="v3-visual-table">
        <thead>
          <tr>
            <th />
            {block.series.map((s, i) => (
              <th key={i}>{s.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.labels.map((label, i) => (
            <tr key={i}>
              <td>{label}</td>
              {block.series.map((s, si) => (
                <td key={si}>{fmtValue(s.values[i], block.unit)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function VerticalPlot({ block }: { block: ChartBlock }): JSX.Element {
  const stack = block.type === 'stacked'
  const max = useMemo(() => {
    const peak = stack
      ? Math.max(...block.labels.map((_, j) => block.series.reduce((sum, s) => sum + s.values[j], 0)))
      : Math.max(...block.series.flatMap((s) => s.values.map(Math.abs)))
    return block.max ?? niceScale(peak, block.unit).max
  }, [block, stack])
  const line = block.type === 'line' || block.type === 'area'

  if (line) {
    const n = block.labels.length
    const W = 600
    const H = 180
    const x = (i: number): number => (n <= 1 ? W / 2 : (i / (n - 1)) * (W - 24) + 12)
    const y = (v: number): number => H - 20 - (v / max) * (H - 40)
    return (
      <div className="v3-visual-plot" role="img" aria-label={block.title}>
        <svg className="v3-visual-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
          <line className="v3-visual-axis" x1="0" y1={H - 20} x2={W} y2={H - 20} vectorEffect="non-scaling-stroke" />
          {block.series.map((s, i) => {
            const points = s.values.map((v, j) => `${x(j)},${y(v)}`).join(' ')
            return (
              <g key={i}>
                {block.type === 'area' && i === 0 ? (
                  <polygon className="v3-visual-area" points={`${x(0)},${H - 20} ${points} ${x(n - 1)},${H - 20}`} fill={seriesColor(i)} opacity="0.16" />
                ) : null}
                <polyline
                  className="v3-visual-line"
                  points={points}
                  fill="none"
                  stroke={seriesColor(i)}
                  strokeWidth="2"
                  strokeDasharray={i % 2 ? '5 3' : undefined}
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            )
          })}
        </svg>
        <div className="v3-visual-axis-labels">
          {block.labels.map((label, i) => (
            <span key={i}>{label}</span>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className={`v3-visual-plot v3-visual-bars${stack ? ' is-stacked' : ''}`} role="img" aria-label={block.title}>
      {block.labels.map((label, j) => (
        <div className="v3-visual-col" key={j}>
          <div className="v3-visual-col-bars">
            {block.series.map((s, i) => (
              <span
                key={i}
                className="v3-visual-bar"
                style={{ height: `${Math.max(1, (Math.abs(s.values[j]) / max) * 100)}%`, background: seriesColor(i) } as CSSProperties}
                title={`${s.name}: ${fmtValue(s.values[j], block.unit)}`}
              />
            ))}
          </div>
          <span className="v3-visual-col-label" title={label}>
            {label}
          </span>
        </div>
      ))}
    </div>
  )
}

function HorizontalPlot({ block }: { block: ChartBlock }): JSX.Element {
  const diverging = block.type === 'diverging'
  const max = useMemo(() => {
    const peak = Math.max(...block.series.flatMap((s) => s.values.map(Math.abs)))
    return block.max ?? niceScale(peak, block.unit).max
  }, [block])
  const single = block.series[0]
  return (
    <div className="v3-visual-hplot" role="img" aria-label={block.title}>
      {block.labels.map((label, j) => (
        <div className="v3-visual-hrow" key={j}>
          <span className="v3-visual-col-label" title={label}>
            {label}
          </span>
          <span className="v3-visual-track">
            {diverging ? (
              <>
                <span className="v3-visual-center" aria-hidden />
                <span
                  className="v3-visual-hbar is-diverging"
                  style={
                    {
                      width: `${(Math.abs(single.values[j]) / max) * 50}%`,
                      left: single.values[j] < 0 ? undefined : '50%',
                      right: single.values[j] < 0 ? '50%' : undefined,
                      background: single.values[j] < 0 ? 'var(--fail)' : seriesColor(0)
                    } as CSSProperties
                  }
                />
              </>
            ) : (
              block.series.map((s, i) => (
                <span
                  key={i}
                  className="v3-visual-hbar"
                  style={{ width: `${(Math.abs(s.values[j]) / max) * 100}%`, background: seriesColor(i) } as CSSProperties}
                  title={`${s.name}: ${fmtValue(s.values[j], block.unit)}`}
                />
              ))
            )}
          </span>
          <span className="v3-visual-hvalue">{fmtValue(block.series[block.series.length - 1].values[j], block.unit)}</span>
        </div>
      ))}
    </div>
  )
}

export function VisualChart({ block }: { block: ChartBlock }): JSX.Element {
  const t = useT()
  const horizontal = block.type === 'hbar' || block.type === 'dumbbell' || block.type === 'diverging'
  const n = block.series.length
  return (
    <section className="v3-visual v3-visual-chart" data-testid="v3-visual-chart" data-type={block.type}>
      <header className="v3-visual-head">
        <span className="v3-visual-title">{block.title}</span>
        {block.subtitle ? <span className="v3-visual-sub">{block.subtitle}</span> : null}
      </header>
      {block.stats?.length ? (
        <div className="v3-visual-stats">
          {block.stats.map((s, i) => (
            <span className="v3-visual-stat" key={i}>
              <span className="v3-visual-stat-label">{s.label}</span>
              <span className="v3-visual-stat-value">{s.value}</span>
              {s.detail ? <span className="v3-visual-stat-detail">{s.detail}</span> : null}
            </span>
          ))}
        </div>
      ) : null}
      {n > 1 ? (
        <div className="v3-visual-legend">
          {block.series.map((s, i) => (
            <span className="v3-visual-legend-item" key={i}>
              <i style={{ background: seriesColor(i) } as CSSProperties} aria-hidden />
              {s.name}
            </span>
          ))}
        </div>
      ) : null}
      {horizontal ? <HorizontalPlot block={block} /> : <VerticalPlot block={block} />}
      <footer className="v3-visual-foot">
        <span className="v3-visual-source">
          {block.source}
          {block.note ? ` · ${block.note}` : ''}
        </span>
        <details className="v3-visual-data">
          <summary>{t('vb.table')}</summary>
          <ChartTable block={block} />
        </details>
      </footer>
    </section>
  )
}
