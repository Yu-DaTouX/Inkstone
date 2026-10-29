import type { HTMLAttributes, ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, Info, OctagonAlert } from 'lucide-react'
import { cx } from './cx'
import { CONTROL_ICON_SIZE } from './sizes'
import { Spinner } from './Progress'

export type NoticeTone = 'info' | 'ok' | 'ask' | 'stall' | 'fail'

export interface NoticeProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  tone?: NoticeTone
  title?: ReactNode
  action?: ReactNode
  icon?: ReactNode | false
  compact?: boolean
  loading?: boolean
  variant?: 'block' | 'hint'
}

const ICONS: Record<NoticeTone, typeof Info> = {
  info: Info,
  ok: CheckCircle2,
  ask: AlertTriangle,
  stall: AlertTriangle,
  fail: OctagonAlert
}

export function Notice({ tone = 'info', title, action, icon, compact, loading = false, variant = 'block', className, children, role, ...rest }: NoticeProps) {
  const Glyph = ICONS[tone]
  const hint = variant === 'hint'
  const glyph = loading
    ? <Spinner size={hint ? 'xs' : 'sm'} />
    : icon === false || (hint && icon == null && tone === 'info')
      ? null
      : (icon ?? <Glyph size={hint ? CONTROL_ICON_SIZE.xs : CONTROL_ICON_SIZE.sm} />)
  return (
    <div
      {...rest}
      role={role ?? (tone === 'fail' ? 'alert' : 'status')}
      aria-busy={loading || undefined}
      className={cx('ui-notice', `ui-notice--${tone}`, compact && 'ui-notice--compact', hint && 'ui-notice--hint', className)}
    >
      {glyph == null ? null : <span className="ui-notice__icon" aria-hidden="true">{glyph}</span>}
      <div className="ui-notice__body">
        {title != null ? <div className="ui-notice__title">{title}</div> : null}
        {children != null ? <div className="ui-notice__text">{children}</div> : null}
      </div>
      {action != null ? <div className="ui-notice__action">{action}</div> : null}
    </div>
  )
}
