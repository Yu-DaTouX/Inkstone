import type { JSX } from 'react'
import { Archive, TriangleAlert } from 'lucide-react'
import { StatusDot, StatusSlot } from '../../ui'
import type { SessionStatusKind } from './session-status'

const DOT_KIND = {
  running: 'running',
  awaiting: 'awaiting',
  unread: 'ready',
  idle: 'idle'
} as const

export function SessionStatusIcon({ kind, label }: { kind: SessionStatusKind; label: string }): JSX.Element {
  if (kind === 'archived') {
    return (
      <StatusSlot tone="muted" label={label}>
        <Archive size={14} aria-hidden />
      </StatusSlot>
    )
  }
  if (kind === 'error') {
    return (
      <StatusSlot tone="danger" label={label} live>
        <TriangleAlert size={14} aria-hidden />
      </StatusSlot>
    )
  }
  return (
    <StatusSlot label={kind === 'idle' ? undefined : label} live={kind === 'running' || kind === 'unread'}>
      <StatusDot kind={DOT_KIND[kind]} />
    </StatusSlot>
  )
}
