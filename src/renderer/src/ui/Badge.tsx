import type { HTMLAttributes, ReactNode } from 'react'
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

export interface KbdProps extends HTMLAttributes<HTMLElement> {
  children: ReactNode
}

export function Kbd({ className, children, ...rest }: KbdProps) {
  return (
    <kbd {...rest} className={cx('ui-kbd', className)}>
      {children}
    </kbd>
  )
}

export interface KbdGroupProps extends HTMLAttributes<HTMLElement> {
  keys?: readonly ReactNode[]
  children?: ReactNode
}

export function KbdGroup({ keys, className, children, ...rest }: KbdGroupProps) {
  return (
    <kbd {...rest} className={cx('ui-kbd-group', className)}>
      {keys != null ? keys.map((key, index) => <Kbd key={index}>{key}</Kbd>) : children}
    </kbd>
  )
}
