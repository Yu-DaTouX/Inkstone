import { type CSSProperties, type ReactNode } from 'react'
import { ArrowUpRight } from 'lucide-react'
import { Card, CardStatus, type CardStatusTone } from './Card'
import './SourceCard.css'

export interface SourceCardProps {
  title: string
  domain: string
  href: string
  icon: ReactNode
  number: number
  index?: number
  label: string
  hint?: string
  status?: ReactNode
  statusTone?: CardStatusTone
  meta?: ReactNode
  onOpen(): void
}

export function SourceCard({ title, domain, href, icon, number, index = 0, label, hint, status, statusTone = 'muted', meta, onOpen }: SourceCardProps) {
  return (
    <Card padding="none" className="ui-source-card ws-source" interactive style={{ '--source-index': Math.min(index, 6) } as CSSProperties}>
      <a className="ui-source-card__link" href={href} aria-label={label} title={hint} onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onOpen()
      }} onAuxClick={(event) => event.preventDefault()}>
        <span className="ui-source-card__head">
          {icon}
          <span className="ui-source-card__domain">{domain}</span>
          <span className="ui-source-card__mark" aria-hidden="true">
            <span className="ui-source-card__number">{number}</span>
            <ArrowUpRight size={14} className="ui-source-card__arrow" />
          </span>
        </span>
        <span className="ui-source-card__title">{title}</span>
        {status || meta ? (
          <span className="ui-source-card__foot">
            {status ? <CardStatus tone={statusTone}><span className="ui-source-card__dot" />{status}</CardStatus> : null}
            {meta ? <span className="ui-source-card__meta">{meta}</span> : null}
          </span>
        ) : null}
      </a>
    </Card>
  )
}
