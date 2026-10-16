import type { CSSProperties } from 'react'
import { cx } from './cx'

export type SkeletonShape = 'text' | 'rect' | 'circle'

export interface SkeletonProps {
  shape?: SkeletonShape
  width?: CSSProperties['width']
  height?: CSSProperties['height']
  className?: string
}

export function Skeleton({ shape = 'text', width, height, className }: SkeletonProps) {
  return (
    <span
      className={cx('ui-skeleton', `ui-skeleton--${shape}`, className)}
      aria-hidden="true"
      style={{ width, height }}
    />
  )
}
