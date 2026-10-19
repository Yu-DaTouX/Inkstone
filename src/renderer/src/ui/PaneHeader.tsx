import type { HTMLAttributes, ReactNode } from 'react'
import { cx } from './cx'

export interface PaneHeaderProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title?: ReactNode
  icon?: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  size?: 'sm' | 'md'
}

export function PaneHeader({ title, icon, meta, actions, size = 'md', className, children, ...rest }: PaneHeaderProps) {
  return (
    <div {...rest} className={cx('ui-pane-head', `ui-pane-head--${size}`, className)}>
      {icon != null ? <span className="ui-pane-head__icon" aria-hidden="true">{icon}</span> : null}
      {title != null ? <span className="ui-pane-head__title">{title}</span> : null}
      {meta != null ? <span className="ui-pane-head__meta">{meta}</span> : null}
      {children}
      {actions != null ? <span className="ui-pane-head__actions">{actions}</span> : null}
    </div>
  )
}
