import { useLayoutEffect, useRef, useState } from 'react'
import { useT } from '../../i18n'
import { niceScale, type ChartBlock } from '../../../../shared/visual-blocks'
import { VisualSources } from './VisualParts'

/**
 * 图表：按容器真实像素绘制（字号不随窗口被等比放大），比例尺由宿主计算。
 * 七种形态共用坐标与配色：系列色依次为 --vb-1..4，第二、四组用虚线 / 斜纹，图例不只靠颜色。
 */

const PAD = { left: 52, right: 16, top: 20, bottom: 30 }

function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(640)
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const update = (): void => { const w = Math.round(node.clientWidth); if (w > 0) setWidth(w) }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  return [ref, width]
}

export function fmtValue(value: number, unit?: string): string {
  const text = Number.isInteger(value) ? String(value) : value.toFixed(Math.abs(value) < 10 ? 2 : 1).replace(/\.?0+$/, '')
  return unit ? `${text}${unit === '%' ? '%' : ` ${unit}`}` : text
}

const color = (i: number): React.CSSProperties => ({ '--vb-c': `var(--vb-${(i % 4) + 1})` } as React.CSSProperties)

export function Chart({ block }: { block: ChartBlock }) {
  const t = useT()
  const [plotRef, W] = useWidth()
  const n = block.series.length
  /* 类别多时纵向放不下（标签与数值互相压住），偏离型也改成横向 */
  const horizontal = block.type === 'hbar' || block.type === 'dumbbell' || (block.type === 'diverging' && block.labels.length > 8)
  const tall = horizontal && block.labels.length > 12
  const showLegend = n > 1
  return (
    <figure className="vb vb-chart" data-testid="vb-chart" data-type={block.type}>
      <figcaption className="vb-head">
        <span className="vb-title">{block.title}</span>
        {block.subtitle ? <span className="vb-sub">{block.subtitle}</span> : null}
      </figcaption>
      {block.stats?.length ? (
        <div className="vb-stats">
          {block.stats.map((s, i) => (
            <div key={i} className="vb-stat">
              <span className="vb-stat-label">{s.label}</span>
              <span className="vb-stat-value">{s.value}</span>
              {s.detail ? <span className="vb-stat-detail">{s.detail}</span> : null}
            </div>
          ))}
        </div>
      ) : null}
      {showLegend ? (
        <div className="vb-legend">
          {block.series.map((s, i) => <span key={i} className={`vb-legend-item${i % 2 ? ' alt' : ''}`} style={color(i)}>{s.name}</span>)}
        </div>
      ) : null}
      <div ref={plotRef} className="vb-plot-wrap" style={tall ? { maxHeight: 320, overflowY: 'auto' } : undefined}>
        {horizontal ? <HorizontalPlot block={block} W={W} /> : <VerticalPlot block={block} W={W} />}
      </div>
      <div className="vb-foot">
        <span className="vb-source-line">{t('vb.source')}：{block.source}</span>
        <details className="vb-data">
          <summary>{t('vb.table')}</summary>
          <div className="md-table-wrap">
            <table>
              <thead><tr><th />{block.series.map((s, i) => <th key={i}>{s.name}</th>)}</tr></thead>
              <tbody>{block.labels.map((label, i) => <tr key={i}><td>{label}</td>{block.series.map((s, si) => <td key={si}>{fmtValue(s.values[i], block.unit)}</td>)}</tr>)}</tbody>
            </table>
          </div>
        </details>
      </div>
      {block.note ? <p className="vb-note">{block.note}</p> : null}
      <VisualSources items={block.sources} />
    </figure>
  )
}

/* ---------------------------------------------------------------- 纵向：柱 / 堆叠 / 折线 / 面积 / 偏离 */

function VerticalPlot({ block, W }: { block: ChartBlock; W: number }) {
  const t = useT()
  const H = Math.round(Math.min(200, Math.max(150, W * 0.32)))
  const n = block.series.length
  const stacked = block.type === 'stacked'
  const diverging = block.type === 'diverging'
  const totals = block.labels.map((_, j) => block.series.reduce((sum, s) => sum + s.values[j], 0))
  const peak = stacked ? Math.max(...totals) : Math.max(...block.series.flatMap((s) => s.values.map(Math.abs)))
  const half = block.max ? { max: block.max, ticks: [0, 1, 2, 3, 4].map((i) => Number(((block.max! / 4) * i).toPrecision(6))) } : niceScale(peak, block.unit)
  /* 偏离：上下对称，0 在中间 */
  const lo = diverging ? -half.max : 0
  const hi = half.max
  const ticks = diverging ? [...half.ticks.slice(1).reverse().map((v) => -v), ...half.ticks] : half.ticks
  const plotW = W - PAD.left - PAD.right
  const plotH = H - PAD.top - PAD.bottom
  const y = (v: number): number => PAD.top + plotH - ((v - lo) / (hi - lo)) * plotH
  const groupW = plotW / block.labels.length
  const lanes = stacked || diverging ? 1 : n
  const barW = Math.min(24 * (stacked ? 2 : 1.5), (groupW * 0.62) / lanes)
  const x0 = (i: number): number => PAD.left + groupW * i + (groupW - barW * lanes) / 2
  const cx = (i: number): number => PAD.left + groupW * (i + 0.5)
  const line = block.type === 'line' || block.type === 'area'

  return (
    <svg className="vb-plot" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${block.title}。${t('vb.source')}：${block.source}`}>
      {ticks.map((tick) => (
        <g key={tick}>
          <line className={`vb-grid${tick === 0 && diverging ? ' base' : ''}`} x1={PAD.left} x2={W - PAD.right} y1={y(tick)} y2={y(tick)} />
          <text className="vb-axis" x={PAD.left - 8} y={y(tick)} textAnchor="end" dominantBaseline="middle">{fmtValue(tick, block.unit)}</text>
        </g>
      ))}
      {block.labels.map((label, i) => (
        <text key={i} className="vb-axis vb-cat" x={cx(i)} y={H - 10} textAnchor="middle">{label}</text>
      ))}
      {block.type === 'bar' && block.series.map((s, si) => s.values.map((v, i) => {
        const top = y(v)
        const x = x0(i) + barW * si
        return (
          <g key={`${si}-${i}`} className={`vb-bar-group${si % 2 ? ' alt' : ''}`} style={{ ...color(si), '--vb-i': i } as React.CSSProperties}>
            <rect className="vb-bar" x={x + 1} y={top} width={Math.max(2, barW - 2)} height={Math.max(0, y(0) - top)} rx={Math.min(4, barW / 4)} />
            <text className="vb-value" x={x + barW / 2} y={top - 6} textAnchor="middle">{fmtValue(v, block.unit)}</text>
          </g>
        )
      }))}
      {stacked && block.labels.map((_, i) => {
        let acc = 0
        return (
          <g key={i} style={{ '--vb-i': i } as React.CSSProperties}>
            {block.series.map((s, si) => {
              const from = acc
              acc += s.values[i]
              const top = y(acc)
              return <rect key={si} className={`vb-bar vb-seg${si % 2 ? ' alt' : ''}`} style={color(si)} x={x0(i) + 1} y={top} width={Math.max(2, barW - 2)} height={Math.max(0, y(from) - top - (si < n - 1 ? 2 : 0))} />
            })}
            <text className="vb-value" x={x0(i) + barW / 2} y={y(totals[i]) - 6} textAnchor="middle">{fmtValue(totals[i], block.unit)}</text>
          </g>
        )
      })}
      {diverging && block.series[0].values.map((v, i) => {
        const top = Math.min(y(v), y(0))
        return (
          <g key={i} className={`vb-bar-group${v < 0 ? ' neg' : ''}`} style={{ ...color(0), '--vb-i': i } as React.CSSProperties}>
            <rect className="vb-bar" x={x0(i) + 1} y={top} width={Math.max(2, barW - 2)} height={Math.abs(y(v) - y(0))} rx={Math.min(4, barW / 4)} />
            <text className="vb-value" x={x0(i) + barW / 2} y={v < 0 ? y(v) + 14 : y(v) - 6} textAnchor="middle">{v > 0 ? '+' : ''}{fmtValue(v, block.unit)}</text>
          </g>
        )
      })}
      {line && block.series.map((s, si) => {
        const points = s.values.map((v, i) => `${cx(i)},${y(v)}`).join(' ')
        return (
          <g key={si} className={`vb-line-group${si % 2 ? ' alt' : ''}`} style={color(si)}>
            {block.type === 'area' ? <polygon className="vb-area" points={`${cx(0)},${y(0)} ${points} ${cx(s.values.length - 1)},${y(0)}`} /> : null}
            <polyline className="vb-line" points={points} />
            {s.values.map((v, i) => (
              <g key={i}>
                <circle className="vb-dot" cx={cx(i)} cy={y(v)} r={3.5} />
                {i === s.values.length - 1 ? <text className="vb-value" x={cx(i)} y={y(v) - 9} textAnchor="middle">{fmtValue(v, block.unit)}</text> : null}
              </g>
            ))}
          </g>
        )
      })}
    </svg>
  )
}

/* ---------------------------------------------------------------- 横向：长类别名的柱 / 前后对比哑铃 */

function HorizontalPlot({ block, W }: { block: ChartBlock; W: number }) {
  const t = useT()
  const row = block.labels.length > 10 ? 22 : 26
  const diverging = block.type === 'diverging'
  const labelW = Math.min(180, Math.max(64, Math.max(...block.labels.map((l) => l.length)) * 16))
  const left = labelW + 12
  const right = 56
  const H = block.labels.length * row + 28
  const peak = Math.max(...block.series.flatMap((s) => s.values.map(Math.abs)))
  const half = block.max ? { max: block.max, ticks: [0, 1, 2, 3, 4].map((i) => Number(((block.max! / 4) * i).toPrecision(6))) } : niceScale(peak, block.unit)
  /* 偏离：0 画在基线上，负的一侧只留数据需要的宽度 */
  const negPeak = Math.max(0, ...block.series.flatMap((s) => s.values.map((v) => -v)))
  const negMax = diverging && negPeak > 0 ? niceScale(negPeak, block.unit).max : 0
  const lo = -negMax
  const scale = { max: half.max, ticks: negMax > 0 ? [-negMax, ...half.ticks] : half.ticks }
  const x = (v: number): number => left + ((v - lo) / (half.max - lo)) * (W - left - right)
  const cy = (i: number): number => 8 + row * i + row / 2
  const dumbbell = block.type === 'dumbbell'
  const n = block.series.length
  const barH = Math.min(18, (row - 8) / (dumbbell ? 1 : n))
  return (
    <svg className="vb-plot" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${block.title}。${t('vb.source')}：${block.source}`}>
      {scale.ticks.map((tick) => (
        <g key={tick}>
          <line className={`vb-grid${tick === 0 && diverging ? ' base' : ''}`} x1={x(tick)} x2={x(tick)} y1={4} y2={H - 22} />
          <text className="vb-axis" x={x(tick)} y={H - 6} textAnchor="middle">{fmtValue(tick, block.unit)}</text>
        </g>
      ))}
      {block.labels.map((label, i) => (
        <text key={i} className="vb-axis vb-cat" x={labelW} y={cy(i)} textAnchor="end" dominantBaseline="middle">{label}</text>
      ))}
      {dumbbell
        ? block.labels.map((_, i) => {
            const a = block.series[0].values[i], b = block.series[1].values[i]
            return (
              <g key={i} className="vb-dumbbell" style={{ '--vb-i': i } as React.CSSProperties}>
                <line className="vb-dumbbell-line" x1={x(a)} x2={x(b)} y1={cy(i)} y2={cy(i)} />
                <circle className="vb-dot before" style={color(1)} cx={x(a)} cy={cy(i)} r={5} />
                <circle className="vb-dot after" style={color(0)} cx={x(b)} cy={cy(i)} r={5} />
                <text className="vb-value" x={Math.max(x(a), x(b)) + 10} y={cy(i)} dominantBaseline="middle">{fmtValue(b, block.unit)}</text>
              </g>
            )
          })
        : block.series.map((s, si) => s.values.map((v, i) => {
            const top = cy(i) - (barH * n) / 2 + barH * si
            return (
              <g key={`${si}-${i}`} className={`vb-bar-group${si % 2 ? ' alt' : ''}`} style={{ ...color(si), '--vb-i': i } as React.CSSProperties}>
                <rect className="vb-bar vb-hbar" x={Math.min(x(0), x(v))} y={top + 1} width={Math.max(0, Math.abs(x(v) - x(0)))} height={Math.max(2, barH - 2)} rx={Math.min(4, barH / 4)} />
                {/* 负值的数字放在基线右侧：放在条的左端会压到类别名 */}
                <text className="vb-value" x={x(Math.max(v, 0)) + 6} y={top + barH / 2} dominantBaseline="middle">{fmtValue(v, block.unit)}</text>
              </g>
            )
          }))}
    </svg>
  )
}

/* ---------------------------------------------------------------- 小趋势线（指标行用） */

export function Sparkline({ values, tone }: { values: number[]; tone?: string }) {
  const W = 96, H = 28
  const lo = Math.min(...values), hi = Math.max(...values)
  const span = hi - lo || 1
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * (W - 4) + 2},${H - 3 - ((v - lo) / span) * (H - 6)}`)
  const last = pts[pts.length - 1].split(',')
  return (
    <svg className={`vb-spark${tone ? ` ${tone}` : ''}`} width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden>
      <polyline points={pts.join(' ')} />
      <circle cx={last[0]} cy={last[1]} r={2.5} />
    </svg>
  )
}
