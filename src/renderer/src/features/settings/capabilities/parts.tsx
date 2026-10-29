import { Fragment, type ReactElement, type ReactNode } from 'react'
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
  return <EmptyState size="sm" align="start" title={children} />
}

export type EntryMetaPart = ReactNode | false | null | undefined

function trimSentenceEnd(part: string): string {
  return part.replace(/[。.]\s*$/, '')
}

function joinsWithoutSeparator(part: ReactNode): boolean {
  return typeof part === 'string' && /^[（(]/.test(part)
}

export function Entry({
  name,
  nameTitle,
  badge,
  control,
  meta,
  metaTitle,
  actions,
  children,
  testId,
  settingId
}: {
  name: ReactNode
  nameTitle?: string
  badge?: ReactNode
  control?: ReactNode
  meta?: readonly EntryMetaPart[]
  metaTitle?: string
  actions?: ReactNode
  children?: ReactNode
  testId?: string
  settingId?: string
}): ReactElement {
  const parts = (meta ?? []).filter((part) => part !== false && part !== null && part !== undefined && part !== '')
  const title = metaTitle ?? (parts.every((part) => typeof part === 'string')
    ? parts.map((part, index) => (index < parts.length - 1 ? trimSentenceEnd(part as string) : part)).join(' · ')
    : undefined)
  return (
    <article className="caps-item" data-testid={testId} data-setting-id={settingId}>
      <div className="caps-item-head">
        <span className="caps-name" title={nameTitle}>
          {name}
        </span>
        {badge}
        <span className="caps-spacer" />
        {control}
      </div>
      {parts.length > 0 ? (
        <p className="caps-meta caps-meta--line" title={title}>
          {parts.map((part, index) => (
            <Fragment key={index}>
              {index > 0 && !joinsWithoutSeparator(part) ? <span className="caps-meta-sep" aria-hidden="true"> · </span> : null}
              {index < parts.length - 1 && typeof part === 'string' ? trimSentenceEnd(part) : part}
            </Fragment>
          ))}
        </p>
      ) : null}
      {children}
      {actions ? <div className="caps-actions">{actions}</div> : null}
    </article>
  )
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
      <div className={card ? 'caps-card' : 'caps-group-body'}>{children}</div>
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
