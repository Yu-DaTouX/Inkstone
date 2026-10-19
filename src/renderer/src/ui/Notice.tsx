import type { HTMLAttributes, ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, Info, OctagonAlert } from 'lucide-react'
import { cx } from './cx'

export type NoticeTone = 'info' | 'ok' | 'ask' | 'stall' | 'fail'

export interface NoticeProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  tone?: NoticeTone
  title?: ReactNode
  action?: ReactNode
  icon?: ReactNode | false
  compact?: boolean
}

const ICONS: Record<NoticeTone, typeof Info> = {
  info: Info,
  ok: CheckCircle2,
  ask: AlertTriangle,
  stall: AlertTriangle,
  fail: OctagonAlert
}

export function Notice({ tone = 'info', title, action, icon, compact, className, children, role, ...rest }: NoticeProps) {
  const Glyph = ICONS[tone]
  return (
    <div
      {...rest}
      role={role ?? (tone === 'fail' ? 'alert' : 'status')}
      className={cx('ui-notice', `ui-notice--${tone}`, compact && 'ui-notice--compact', className)}
    >
      {icon === false ? null : <span className="ui-notice__icon" aria-hidden="true">{icon ?? <Glyph size={14} />}</span>}
      <div className="ui-notice__body">
        {title != null ? <div className="ui-notice__title">{title}</div> : null}
        {children != null ? <div className="ui-notice__text">{children}</div> : null}
      </div>
      {action != null ? <div className="ui-notice__action">{action}</div> : null}
    </div>
  )
}
