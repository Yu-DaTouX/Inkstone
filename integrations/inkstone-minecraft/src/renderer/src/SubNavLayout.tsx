import type { ReactElement, ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'
import { TooltipTrigger } from 'react-aria-components'
import { IconButton } from '@yan/ui/IconButton'
import { Tooltip } from '@yan/ui/Tooltip'

export interface SubNavItem<T extends string> {
  id: T
  label: string
  icon: ReactNode
}

export interface SubNavGroup<T extends string> {
  label?: string
  items: SubNavItem<T>[]
}

interface Props<T extends string> {
  label: string
  groups: SubNavGroup<T>[]
  active: T
  onChange(id: T): void
  header?: ReactNode
  onBack?: () => void
  backLabel?: string
  children: ReactNode
}

export function SubNavLayout<T extends string>({ label, groups, active, onChange, header, onBack, backLabel, children }: Props<T>): ReactElement {
  return (
    <div className="subnav-layout">
      <nav className="subnav" aria-label={label}>
        {onBack ? (
          <div className="subnav__back">
            <IconButton aria-label={backLabel ?? '返回'} size="sm" onPress={onBack}>
              <ArrowLeft size={16} />
            </IconButton>
            <div className="subnav__header">{header}</div>
          </div>
        ) : header ? (
          <div className="subnav__header subnav__header--plain">{header}</div>
        ) : null}
        {groups.map((group, index) => (
          <div key={group.label ?? index} className="subnav__group" role="group" aria-label={group.label}>
            {group.label ? <div className="subnav__group-label">{group.label}</div> : null}
            {group.items.map((item) => (
              <TooltipTrigger key={item.id} delay={400}>
                <button type="button" className="subnav__item" aria-current={item.id === active ? 'page' : undefined} onClick={() => onChange(item.id)}>
                  <span className="subnav__icon" aria-hidden="true">
                    {item.icon}
                  </span>
                  <span className="subnav__label">{item.label}</span>
                </button>
                <Tooltip placement="right" className="subnav__tip">
                  {item.label}
                </Tooltip>
              </TooltipTrigger>
            ))}
          </div>
        ))}
      </nav>
      <div className="subnav-content">{children}</div>
    </div>
  )
}

interface PageHeadProps {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
}

export function PageHead({ title, description, actions }: PageHeadProps): ReactElement {
  return (
    <header className="page-head">
      <div className="page-head__text">
        <h1 className="page-head__title">{title}</h1>
        {description ? <p className="page-head__desc">{description}</p> : null}
      </div>
      {actions ? <div className="page-head__actions">{actions}</div> : null}
    </header>
  )
}

interface EmptyBlockProps {
  icon?: ReactNode
  title: string
  children?: ReactNode
  actions?: ReactNode
}

export function EmptyBlock({ icon, title, children, actions }: EmptyBlockProps): ReactElement {
  return (
    <div className="empty-block">
      {icon ? (
        <span className="empty-block__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <h2 className="empty-block__title">{title}</h2>
      {children ? <p className="empty-block__text">{children}</p> : null}
      {actions ? <div className="empty-block__actions">{actions}</div> : null}
    </div>
  )
}
