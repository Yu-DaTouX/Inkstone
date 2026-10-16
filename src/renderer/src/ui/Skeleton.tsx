import type { CSSProperties } from 'react'
import { cx } from './cx'

export type SkeletonShape = 'text' | 'rect' | 'circle'

export interface SkeletonProps {
  shape?: SkeletonShape
  /** 文字行宽度，比如 `'60%'` 或 `'12ch'`。 */
  width?: CSSProperties['width']
  height?: CSSProperties['height']
  className?: string
}

/** 加载占位。尺寸尽量贴近真实内容，避免出现时跳动；`aria-hidden` 不参与朗读。 */
export function Skeleton({ shape = 'text', width, height, className }: SkeletonProps) {
  return (
    <span
      className={cx('ui-skeleton', `ui-skeleton--${shape}`, className)}
      aria-hidden="true"
      style={{ width, height }}
    />
  )
}
