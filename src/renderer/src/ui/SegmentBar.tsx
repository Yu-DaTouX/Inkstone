import type { HTMLAttributes } from 'react'
import { cx } from './cx'
import './SegmentBar.css'

export type DataTone = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8

export interface SegmentBarSegment {
  key: string
  value: number
  tone: DataTone
}

export interface SegmentBarProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'role'> {
  segments: readonly SegmentBarSegment[]
  'aria-label': string
}

export function segmentShares(segments: readonly SegmentBarSegment[]): number[] {
  const values = segments.map((s) => (Number.isFinite(s.value) && s.value > 0 ? s.value : 0))
  const sum = values.reduce((a, b) => a + b, 0)
  return values.map((v) => (sum > 0 ? (v / sum) * 100 : 0))
}

export function SegmentBar({ segments, className, ...rest }: SegmentBarProps) {
  const shares = segmentShares(segments)
  return (
    <div {...rest} role="img" className={cx('ui-segbar', className)}>
      {segments.map((segment, i) => (
        <span
          key={segment.key}
          className="ui-segbar__seg"
          data-tone={segment.tone}
          data-empty={shares[i] > 0 ? undefined : '1'}
          style={{ width: `${shares[i]}%` }}
        />
      ))}
    </div>
  )
}

export interface SwatchProps {
  tone: DataTone
  className?: string
}

export function Swatch({ tone, className }: SwatchProps) {
  return <span className={cx('ui-swatch', className)} data-tone={tone} aria-hidden="true" />
}
