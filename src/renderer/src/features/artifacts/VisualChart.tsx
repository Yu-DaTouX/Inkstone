import { useMemo, type CSSProperties, type JSX, type ReactNode } from 'react'
import { useT } from '../../i18n'
import { Stat, StatGrid } from '../../ui'
import { niceScale, type ChartBlock } from '../../../../shared/visual-blocks'

const SERIES_COLORS = ['var(--data-1)', 'var(--data-2)', 'var(--data-3)', 'var(--data-4)'] as const
const LINE_TICKS = 3

function seriesColor(index: number): string {
  return SERIES_COLORS[index % SERIES_COLORS.length]
}

export function fmtValue(value: number, unit?: string): string {
  const text = Number.isInteger(value) ? String(value) : value.toFixed(Math.abs(value) < 10 ? 2 : 1).replace(/\.?0+$/, '')
  return unit ? `${text}${unit === '%' ? '%' : ` ${unit}`}` : text
}

function niceStep(span: number): number {
  const raw = span / LINE_TICKS || 1
  const power = 10 ** Math.floor(Math.log10(raw))
  const unit = raw / power
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * power
}

export function lineDomain(values: readonly number[], fromZero: boolean, fixedMax?: number): { lo: number; hi: number; ticks: number[] } {
  const min = Math.min(...values)
  const max = fixedMax ?? Math.max(...values)
  const step = niceStep(max - (fromZero ? Math.min(0, min) : min))
  const lo = fromZero ? Math.min(0, Math.floor(min / step) * step) : Math.floor(min / step) * step
  const hi = Math.max(lo + step, Math.ceil(max / step) * step)
  const ticks: number[] = []
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Number(v.toPrecision(12)))
  return { lo, hi, ticks }
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

function LinePlot({ block }: { block: ChartBlock }): JSX.Element {
  const area = block.type === 'area'
  const domain = useMemo(() => lineDomain(block.series.flatMap((s) => s.values), area, block.max), [block, area])
  const n = block.labels.length
  const W = 600
  const H = 120
  const x = (i: number): number => (n <= 1 ? W / 2 : (i / (n - 1)) * W)
  const y = (v: number): number => H - ((v - domain.lo) / (domain.hi - domain.lo || 1)) * H
  const pct = (v: number): string => `${(1 - (v - domain.lo) / (domain.hi - domain.lo || 1)) * 100}%`
  return (
    <div className="v3-visual-line-plot" role="img" aria-label={block.title}>
      <div className="v3-visual-yaxis" aria-hidden>
        {domain.ticks.map((tick) => (
          <span key={tick} style={{ top: pct(tick) } as CSSProperties}>
            {fmtValue(tick)}
          </span>
        ))}
      </div>
      <div className="v3-visual-line-area">
        <svg className="v3-visual-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
          {domain.ticks.map((tick) => (
            <line key={tick} className="v3-visual-grid" x1="0" y1={y(tick)} x2={W} y2={y(tick)} vectorEffect="non-scaling-stroke" />
          ))}
          {block.series.map((s, i) => {
            const points = s.values.map((v, j) => `${x(j)},${y(v)}`).join(' ')
            return (
              <g key={i}>
                {area && i === 0 ? <polygon points={`${x(0)},${H} ${points} ${x(n - 1)},${H}`} fill={seriesColor(i)} opacity="0.14" /> : null}
                <polyline
                  className="v3-visual-line"
                  points={points}
                  fill="none"
                  stroke={seriesColor(i)}
                  strokeWidth="2"
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            )
          })}
        </svg>
        {block.series.map((s, i) => (
          <span
            key={i}
            className="v3-visual-line-end"
            style={{ top: pct(s.values[n - 1]), color: seriesColor(i) } as CSSProperties}
          >
            {fmtValue(s.values[n - 1], block.unit)}
          </span>
        ))}
        <div className="v3-visual-xaxis" aria-hidden>
          {block.labels.map((label, i) => (
            <span key={i} style={{ left: `${n <= 1 ? 50 : (i / (n - 1)) * 100}%` } as CSSProperties}>
              {label}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

function BarPlot({ block }: { block: ChartBlock }): JSX.Element {
  const stack = block.type === 'stacked'
  const max = useMemo(() => {
    const peak = stack
      ? Math.max(...block.labels.map((_, j) => block.series.reduce((sum, s) => sum + s.values[j], 0)))
      : Math.max(...block.series.flatMap((s) => s.values.map(Math.abs)))
    return block.max ?? niceScale(peak, block.unit).max
  }, [block, stack])
  const valued = block.series.length === 1 && block.labels.length <= 12
  return (
    <div className={`v3-visual-plot v3-visual-bars${stack ? ' is-stacked' : ''}${valued ? ' is-valued' : ''}`} role="img" aria-label={block.title}>
      {block.labels.map((label, j) => (
        <div className="v3-visual-col" key={j}>
          <div className="v3-visual-col-bars">
            {valued ? (
              <span className="v3-visual-col-value" style={{ bottom: `${Math.max(1, (Math.abs(block.series[0].values[j]) / max) * 100)}%` } as CSSProperties}>
                {fmtValue(block.series[0].values[j], block.unit)}
              </span>
            ) : null}
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

export function VisualChart({ block, sources }: { block: ChartBlock; sources?: ReactNode }): JSX.Element {
  const t = useT()
  const horizontal = block.type === 'hbar' || block.type === 'dumbbell' || block.type === 'diverging'
  const line = block.type === 'line' || block.type === 'area'
  return (
    <section className="v3-visual v3-visual-chart" data-testid="v3-visual-chart" data-type={block.type}>
      <header className="v3-visual-head">
        <span className="v3-visual-title">{block.title}</span>
        {block.subtitle ? <span className="v3-visual-sub">{block.subtitle}</span> : null}
        {block.series.length > 1 ? (
          <span className="v3-visual-legend">
            {block.series.map((s, i) => (
              <span className="v3-visual-legend-item" key={i}>
                <i style={{ background: seriesColor(i) } as CSSProperties} aria-hidden />
                {s.name}
              </span>
            ))}
          </span>
        ) : null}
      </header>
      {block.stats?.length ? (
        <StatGrid columns={Math.min(block.stats.length, 4)} className="v3-visual-statgrid">
          {block.stats.map((s, i) => (
            <Stat key={i} label={s.label} value={s.value} footer={s.detail ? <span className="v3-visual-stat-detail">{s.detail}</span> : undefined} />
          ))}
        </StatGrid>
      ) : null}
      {horizontal ? <HorizontalPlot block={block} /> : line ? <LinePlot block={block} /> : <BarPlot block={block} />}
      <footer className="v3-visual-foot">
        {block.source || block.note ? (
          <span className="v3-visual-source">
            {block.source}
            {block.source && block.note ? ' · ' : ''}
            {block.note}
          </span>
        ) : null}
        <details className="v3-visual-data">
          <summary>{t('vb.table')}</summary>
          <ChartTable block={block} />
        </details>
      </footer>
      {sources}
    </section>
  )
}
