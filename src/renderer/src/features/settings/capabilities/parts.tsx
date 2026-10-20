import type { ReactElement, ReactNode } from 'react'
import { Badge, EmptyState, Notice, SettingSection, Skeleton, type BadgeTone } from '../../../ui'
import { cx } from '../../../ui/cx'

export function Panel({ children, label }: { children: ReactNode; label: string }): ReactElement {
  return (
    <section className="caps-panel" aria-label={label}>
      {children}
    </section>
  )
}

export function Note({ children, tone }: { children: ReactNode; tone?: 'caution' }): ReactElement {
  if (tone === 'caution') {
    return (
      <Notice tone="ask" compact role="note">
        {children}
      </Notice>
    )
  }
  return (
    <p className="caps-note" role="note">
      {children}
    </p>
  )
}

export function Warn({ children }: { children: ReactNode }): ReactElement {
  return (
    <Notice tone="fail" compact>
      {children}
    </Notice>
  )
}

export function Empty({ children }: { children: ReactNode }): ReactElement {
  return <EmptyState size="sm" title={children} />
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
    <SettingSection className="caps-group" title={title} description={desc} actions={actions} plain data-setting-id={settingId}>
      {card ? <div className="caps-card">{children}</div> : children}
    </SettingSection>
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

export function Meta({ children, title, clamp }: { children: ReactNode; title?: string; clamp?: boolean }): ReactElement {
  return (
    <p className={cx('caps-meta', clamp && 'caps-meta--clamp')} title={title}>
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
