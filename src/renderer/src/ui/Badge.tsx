import type { ReactNode } from 'react'
import { cx } from './cx'

export type BadgeTone = 'neutral' | 'accent' | 'run' | 'ask' | 'stall' | 'fail'

export interface BadgeProps {
  tone?: BadgeTone
  className?: string
  title?: string
  children: ReactNode
}

export function Badge({ tone = 'neutral', className, children, ...rest }: BadgeProps) {
  return (
    <span className={cx('ui-badge', `ui-badge--${tone}`, className)} {...rest}>
      {children}
    </span>
  )
}

export function Kbd({ className, children }: { className?: string; children: ReactNode }) {
  return <kbd className={cx('ui-kbd', className)}>{children}</kbd>
}
