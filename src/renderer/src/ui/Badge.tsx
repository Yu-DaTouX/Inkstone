import type { ReactNode } from 'react'
import { cx } from './cx'

export type BadgeTone = 'neutral' | 'accent' | 'ok' | 'run' | 'ask' | 'stall' | 'fail'

export interface BadgeProps {
  tone?: BadgeTone
  overlay?: boolean
  className?: string
  title?: string
  children: ReactNode
}

export function Badge({ tone = 'neutral', overlay = false, className, children, ...rest }: BadgeProps) {
  return (
    <span className={cx('ui-badge', `ui-badge--${tone}`, overlay && 'ui-badge--overlay', className)} {...rest}>
      {children}
    </span>
  )
}

export function Kbd({ className, children }: { className?: string; children: ReactNode }) {
  return <kbd className={cx('ui-kbd', className)}>{children}</kbd>
}
