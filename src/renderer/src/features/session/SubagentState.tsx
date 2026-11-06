import type { JSX } from 'react'
import { StatusDot, StatusSlot } from '../../ui'
import type { SubagentRowState } from '../../../../shared/subagent-task-rows'
import { Icon } from './Icon'

export function SubagentStateIcon({ state, label, awaiting = false }: { state: SubagentRowState; label?: string; awaiting?: boolean }): JSX.Element {
  if (awaiting && (state === 'starting' || state === 'running')) {
    return (
      <StatusSlot label={label} live>
        <StatusDot kind="awaiting" />
      </StatusSlot>
    )
  }
  switch (state) {
    case 'starting':
    case 'running':
      return (
        <StatusSlot label={label} live>
          <StatusDot kind="running" />
        </StatusSlot>
      )
    case 'stopping':
      return (
        <StatusSlot tone="muted" label={label} live>
          <StatusDot kind="pending" />
        </StatusSlot>
      )
    case 'done':
      return (
        <StatusSlot label={label}>
          <Icon name="check" size={12} />
        </StatusSlot>
      )
    case 'failed':
      return (
        <StatusSlot tone="danger" label={label}>
          <Icon name="alert" size={12} />
        </StatusSlot>
      )
    case 'stopped':
      return (
        <StatusSlot tone="muted" label={label}>
          <Icon name="square" size={10} />
        </StatusSlot>
      )
    default:
      return (
        <StatusSlot tone="muted" label={label}>
          <Icon name="help" size={12} />
        </StatusSlot>
      )
  }
}
