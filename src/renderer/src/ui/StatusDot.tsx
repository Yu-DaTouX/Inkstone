import type { ReactNode } from 'react'
import { cx } from './cx'

export type StatusDotKind = 'running' | 'awaiting' | 'ready' | 'idle' | 'ok' | 'pending' | 'fail'
export type StatusSlotTone = 'default' | 'muted' | 'danger'

export interface StatusDotProps {
  kind: StatusDotKind
  className?: string
}

export function StatusDot({ kind, className }: StatusDotProps) {
  return <span className={cx('ui-status__dot', className)} data-kind={kind} aria-hidden="true" />
}

export interface StatusSlotProps {
  tone?: StatusSlotTone
  label?: string
  live?: boolean
  className?: string
  children: ReactNode
}

export function StatusSlot({ tone = 'default', label, live = false, className, children }: StatusSlotProps) {
  return (
    <span
      className={cx('ui-status', className)}
      data-tone={tone}
      role={label ? (live ? 'status' : 'img') : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {children}
    </span>
  )
}
