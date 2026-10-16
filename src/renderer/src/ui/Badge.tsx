import type { ReactNode } from 'react'
import { cx } from './cx'

export type BadgeTone = 'neutral' | 'accent' | 'run' | 'ask' | 'stall' | 'fail'

export interface BadgeProps {
  tone?: BadgeTone
  className?: string
  /** 悬停能看到全文（被截断的状态词等）。 */
  title?: string
  children: ReactNode
}

/** 状态词 / 计数的浅底小标签。彩色只用于状态，不用于装饰。 */
export function Badge({ tone = 'neutral', className, children, ...rest }: BadgeProps) {
  return (
    <span className={cx('ui-badge', `ui-badge--${tone}`, className)} {...rest}>
      {children}
    </span>
  )
}

/** 键位提示，例如 `Ctrl+B`。 */
export function Kbd({ className, children }: { className?: string; children: ReactNode }) {
  return <kbd className={cx('ui-kbd', className)}>{children}</kbd>
}
