import type { ReactNode } from 'react'
import './StreamNotice.css'

export function StreamNotice(props: { icon?: ReactNode; title?: string; children: ReactNode; meta?: ReactNode; testId?: string }) {
  return (
    <div className="ui-stream-notice" role="note" title={props.title} data-testid={props.testId}>
      <span className="ui-stream-notice__rule" aria-hidden="true" />
      {props.icon}
      <span className="ui-stream-notice__text">{props.children}</span>
      {props.meta ? <span className="ui-stream-notice__meta">{props.meta}</span> : null}
      <span className="ui-stream-notice__rule" aria-hidden="true" />
    </div>
  )
}
