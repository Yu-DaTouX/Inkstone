import { forwardRef, type HTMLAttributes, type ReactNode } from 'react'
import { cx } from './cx'
import './Card.css'

export type CardTone = 'ask' | 'fail'
export type CardStatusTone = 'accent' | 'run' | 'ask' | 'ok' | 'fail' | 'muted'

export interface CardProps extends HTMLAttributes<HTMLElement> {
  as?: 'div' | 'section' | 'article' | 'li'
  padding?: 'none' | 'sm' | 'md'
  interactive?: boolean
  quiet?: boolean
  receipt?: boolean
  tone?: CardTone
}

export const Card = forwardRef<HTMLElement, CardProps>(function Card(
  { as: Tag = 'div', padding = 'md', interactive, quiet, receipt, tone, className, ...rest },
  ref
) {
  return (
    <Tag
      {...rest}
      ref={ref as never}
      data-tone={tone}
      className={cx('ui-card', `ui-card--pad-${padding}`, interactive && 'ui-card--interactive', quiet && 'ui-card--quiet', receipt && 'ui-card--receipt', className)}
    />
  )
})

export function CardHead({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div {...rest} className={cx('ui-card__head', className)} />
}

export interface CardSummaryProps extends Omit<HTMLAttributes<HTMLButtonElement>, 'onClick'> {
  expanded: boolean
  onPress: () => void
}

export function CardSummary({ expanded, onPress, className, children, ...rest }: CardSummaryProps) {
  return (
    <button {...rest} type="button" aria-expanded={expanded} className={cx('ui-card__head', 'ui-card__summary', className)} onClick={onPress}>
      {children}
      <span className="ui-card__control"><CardChevron /></span>
    </button>
  )
}

export interface CardStatusProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: CardStatusTone
  icon?: ReactNode
}

export function CardStatus({ tone = 'muted', icon, className, children, ...rest }: CardStatusProps) {
  return (
    <span {...rest} data-tone={tone} className={cx('ui-card__status', className)}>
      {icon != null ? <span className="ui-card__status-icon" aria-hidden="true">{icon}</span> : null}
      {children}
    </span>
  )
}

export interface CardTitleProps extends HTMLAttributes<HTMLSpanElement> {
  clamp?: boolean
}

export function CardTitle({ clamp, className, ...rest }: CardTitleProps) {
  return <span {...rest} data-clamp={clamp || undefined} className={cx('ui-card__title', className)} />
}

export function CardMeta({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return <span {...rest} className={cx('ui-card__meta', className)} />
}

export function CardControl({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return <span {...rest} className={cx('ui-card__control', className)} />
}

export function CardBody({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div {...rest} className={cx('ui-card__body', className)} />
}

export interface CardCodeProps extends HTMLAttributes<HTMLPreElement> {
  tone?: CardTone
}

export const CardCode = forwardRef<HTMLPreElement, CardCodeProps>(function CardCode({ tone, className, ...rest }, ref) {
  return <pre {...rest} ref={ref} data-tone={tone} className={cx('ui-card__code', className)} />
})

export interface CardActionsProps extends HTMLAttributes<HTMLDivElement> {
  lead?: ReactNode
}

export function CardActions({ lead, className, children, ...rest }: CardActionsProps) {
  return (
    <div {...rest} className={cx('ui-card__actions', className)}>
      {lead != null ? <div className="ui-card__actions-lead">{lead}</div> : null}
      <div className="ui-card__actions-main">{children}</div>
    </div>
  )
}

export function CardChevron() {
  return (
    <svg className="ui-card__chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m9 18 6-6-6-6" />
    </svg>
  )
}

let timeFormats: { clock: Intl.DateTimeFormat; day: Intl.DateTimeFormat; full: Intl.DateTimeFormat } | null = null

function cardTimeFormats(): NonNullable<typeof timeFormats> {
  timeFormats ??= {
    clock: new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }),
    day: new Intl.DateTimeFormat(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
    full: new Intl.DateTimeFormat(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }
  return timeFormats
}

export function CardTime({ at, className }: { at: number; className?: string }) {
  const date = new Date(at)
  if (!Number.isFinite(date.getTime())) return null
  const formats = cardTimeFormats()
  const today = new Date().toDateString() === date.toDateString()
  const full = formats.full.format(date)
  return (
    <time className={cx('ui-card__time', className)} dateTime={date.toISOString()} title={full}>
      {(today ? formats.clock : formats.day).format(date)}
    </time>
  )
}
