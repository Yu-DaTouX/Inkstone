import type { ReactElement, ReactNode } from 'react'
import { Badge, Skeleton, type BadgeTone } from '../../../ui'
import { cx } from '../../../ui/cx'

export function Panel({ children, label }: { children: ReactNode; label: string }): ReactElement {
  return (
    <section className="caps-panel" aria-label={label}>
      {children}
    </section>
  )
}

export function Note({ children, tone }: { children: ReactNode; tone?: 'caution' }): ReactElement {
  return (
    <p className={cx('caps-note', tone === 'caution' && 'caps-note--caution')} role="note">
      {children}
    </p>
  )
}

export function Warn({ children }: { children: ReactNode }): ReactElement {
  return (
    <p className="caps-warn" role="alert">
      {children}
    </p>
  )
}

export function Empty({ children }: { children: ReactNode }): ReactElement {
  return <p className="caps-empty">{children}</p>
}

export function Group({
  title,
  desc,
  actions,
  card,
  settingId,
  children
}: {
  title: string
  desc?: string
  actions?: ReactNode
  card?: boolean
  settingId?: string
  children: ReactNode
}): ReactElement {
  return (
    <section className="caps-group" data-setting-id={settingId}>
      <div className="caps-group-head">
        <div className="caps-group-titles">
          <h3 className="caps-group-title">{title}</h3>
          {desc ? <p className="caps-group-desc">{desc}</p> : null}
        </div>
        {actions ? <div className="caps-actions">{actions}</div> : null}
      </div>
      {card ? <div className="caps-card">{children}</div> : children}
    </section>
  )
}

export function Item({
  children,
  testId,
  settingId
}: {
  children: ReactNode
  testId?: string
  settingId?: string
}): ReactElement {
  return (
    <article className="caps-item" data-testid={testId} data-setting-id={settingId}>
      {children}
    </article>
  )
}

export function ItemHead({ children }: { children: ReactNode }): ReactElement {
  return <div className="caps-item-head">{children}</div>
}

export function Actions({ children }: { children: ReactNode }): ReactElement {
  return <div className="caps-actions">{children}</div>
}

export function Meta({ children, title }: { children: ReactNode; title?: string }): ReactElement {
  return (
    <p className="caps-meta" title={title}>
      {children}
    </p>
  )
}

export function StatusBadge({ tone, children }: { tone: BadgeTone; children: ReactNode }): ReactElement {
  return <Badge tone={tone}>{children}</Badge>
}

export function ListSkeleton({ rows = 3 }: { rows?: number }): ReactElement {
  return (
    <div className="caps-list" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <div className={cx('caps-item', 'caps-item--skeleton')} key={index}>
          <Skeleton className="caps-skel caps-skel--title" />
          <Skeleton className="caps-skel caps-skel--line" />
        </div>
      ))}
    </div>
  )
}
