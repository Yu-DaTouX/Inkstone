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
  snippet?: string
  status?: ReactNode
  statusTone?: CardStatusTone
  meta?: ReactNode
  onOpen(): void
}

export function SourceCard({ title, domain, href, icon, number, index = 0, label, hint, snippet, status, statusTone = 'muted', meta, onOpen }: SourceCardProps) {
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
          <span className="ui-source-card__number" aria-hidden="true">{number}</span>
        </span>
        <span className="ui-source-card__title">{title}</span>
        {snippet ? <span className="ui-source-card__snippet">{snippet}</span> : null}
        <span className="ui-source-card__foot">
          {status ? <CardStatus tone={statusTone}><span className="ui-source-card__dot" />{status}</CardStatus> : null}
          <ArrowUpRight size={14} className="ui-source-card__arrow" aria-hidden="true" />
        </span>
        {meta ? <span className="ui-source-card__meta">{meta}</span> : null}
      </a>
    </Card>
  )
}
