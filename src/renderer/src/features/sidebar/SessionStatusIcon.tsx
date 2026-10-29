import type { JSX } from 'react'
import { TriangleAlert } from 'lucide-react'
import { StatusDot, StatusSlot, TermSpinner } from '../../ui'
import type { SessionStatusKind } from './session-status'

const DOT_KIND = {
  awaiting: 'awaiting',
  unread: 'ready'
} as const

export function sessionStatusHasMark(kind: SessionStatusKind): boolean {
  return kind !== 'idle' && kind !== 'archived'
}

export function SessionStatusIcon({ kind, label }: { kind: SessionStatusKind; label: string }): JSX.Element {
  if (kind === 'idle') return <span className="v3-srow-lane" aria-hidden />
  if (kind === 'archived') return <span className="v3-srow-lane"><span className="v3-visually-hidden">{label}</span></span>
  if (kind === 'running') {
    return (
      <span className="v3-srow-lane" data-kind={kind}>
        <TermSpinner label={label} />
      </span>
    )
  }
  if (kind === 'error') {
    return (
      <span className="v3-srow-lane" data-kind={kind}>
        <StatusSlot tone="danger" label={label} live>
          <TriangleAlert size={12} aria-hidden />
        </StatusSlot>
      </span>
    )
  }
  return (
    <span className="v3-srow-lane" data-kind={kind}>
      <StatusSlot label={label} live>
        <StatusDot kind={DOT_KIND[kind]} />
      </StatusSlot>
    </span>
  )
}
