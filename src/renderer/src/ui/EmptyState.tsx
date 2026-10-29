import type { HTMLAttributes, ReactNode } from 'react'
import { cx } from './cx'

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  icon?: ReactNode
  media?: 'plain' | 'icon'
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  size?: 'sm' | 'md'
  align?: 'center' | 'start'
}

export function EmptyState({
  icon,
  media = 'plain',
  title,
  description,
  action,
  size = 'md',
  align = 'center',
  className,
  ...rest
}: EmptyStateProps) {
  return (
    <div {...rest} className={cx('ui-empty', `ui-empty--${size}`, className)} data-align={align === 'start' ? 'start' : undefined}>
      {icon != null ? (
        media === 'icon' ? (
          <span className="ui-empty__media" aria-hidden="true">
            <span className="ui-empty__tile">{icon}</span>
          </span>
        ) : (
          <span className="ui-empty__icon" aria-hidden="true">{icon}</span>
        )
      ) : null}
      <p className="ui-empty__title">{title}</p>
      {description != null ? <p className="ui-empty__desc">{description}</p> : null}
      {action != null ? <div className="ui-empty__action">{action}</div> : null}
    </div>
  )
}
