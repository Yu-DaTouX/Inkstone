import type { JSX } from 'react'
import { TriangleAlert } from 'lucide-react'
import { StatusDot, StatusSlot } from '../../ui'
import type { SessionStatusKind } from './session-status'

const DOT_KIND = {
  running: 'running',
  awaiting: 'awaiting',
  unread: 'ready'
} as const

export function sessionStatusHasMark(kind: SessionStatusKind): boolean {
  return kind !== 'idle' && kind !== 'archived'
}

export function SessionStatusIcon({ kind, label }: { kind: SessionStatusKind; label: string }): JSX.Element | null {
  if (kind === 'idle') return null
  if (kind === 'archived') return <span className="v3-visually-hidden">{label}</span>
  if (kind === 'error') {
    return (
      <span className="v3-srow-mark">
        <StatusSlot tone="danger" label={label} live>
          <TriangleAlert size={14} aria-hidden />
        </StatusSlot>
      </span>
    )
  }
  return (
    <span className="v3-srow-mark">
      <StatusSlot label={label} live={kind === 'running' || kind === 'unread'}>
        <StatusDot kind={DOT_KIND[kind]} />
      </StatusSlot>
    </span>
  )
}
