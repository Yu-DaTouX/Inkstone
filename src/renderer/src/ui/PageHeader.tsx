import type { HTMLAttributes, ReactNode } from 'react'
import { cx } from './cx'

export interface PageHeaderProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  level?: 2 | 3
  size?: 'md' | 'sm'
}

export function PageHeader({ title, description, actions, level = 2, size = 'md', className, children, ...rest }: PageHeaderProps) {
  const Heading = level === 3 ? 'h3' : 'h2'
  return (
    <header {...rest} className={cx('ui-page-head', className)} data-size={size === 'sm' ? 'sm' : undefined}>
      <div className="ui-page-head__main">
        <Heading className="ui-page-head__title">{title}</Heading>
        {description != null ? <p className="ui-page-head__desc">{description}</p> : null}
        {children}
      </div>
      {actions != null ? <div className="ui-page-head__actions">{actions}</div> : null}
    </header>
  )
}
