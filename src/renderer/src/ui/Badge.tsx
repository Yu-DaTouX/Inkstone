import type { HTMLAttributes, ReactNode } from 'react'
import { cx } from './cx'

export type BadgeDataTone = 'data-1' | 'data-2' | 'data-3' | 'data-4' | 'data-5' | 'data-6' | 'data-7' | 'data-8'

export type BadgeTone = 'neutral' | 'accent' | 'ok' | 'run' | 'ask' | 'stall' | 'fail' | BadgeDataTone

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone
  overlay?: boolean
  shape?: 'default' | 'square'
  children: ReactNode
}

export function Badge({ tone = 'neutral', overlay = false, shape = 'default', className, children, ...rest }: BadgeProps) {
  return (
    <span
      {...rest}
      className={cx('ui-badge', `ui-badge--${tone}`, overlay && 'ui-badge--overlay', shape === 'square' && 'ui-badge--square', className)}
    >
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

export interface KbdGroupProps extends HTMLAttributes<HTMLSpanElement> {
  keys?: readonly ReactNode[]
  children?: ReactNode
}

export function KbdGroup({ keys, className, children, ...rest }: KbdGroupProps) {
  return (
    <span {...rest} className={cx('ui-kbd-group', className)}>
      {keys != null ? keys.map((key, index) => <Kbd key={index}>{key}</Kbd>) : children}
    </span>
  )
}
