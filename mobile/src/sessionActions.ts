import type { RemoteQueue, RemoteQueueOp, RemoteSubagentReview } from '../../src/shared/remote-protocol'
import { parseHostNotice } from '../../src/shared/host-notice'

const visible = (text: string) => !parseHostNotice(text)

export interface QueuedRow {
  kind: 'steer' | 'queue'
  text: string
  id?: string
  digest?: string
  images?: number
}

export type QueueRowAction = 'steer' | 'edit' | 'remove'

export function queuedRows(queue: RemoteQueue | undefined): QueuedRow[] {
  if (!queue) return []
  if (queue.items) {
    return [
      ...queue.items.steering.filter((item) => visible(item.text)).map((item) => ({ kind: 'steer' as const, text: item.text, id: item.id, ...(item.digest ? { digest: item.digest } : {}), ...(item.images ? { images: item.images } : {}) })),
      ...queue.items.followUp.filter((item) => visible(item.text)).map((item) => ({ kind: 'queue' as const, text: item.text, id: item.id, ...(item.digest ? { digest: item.digest } : {}), ...(item.images ? { images: item.images } : {}) }))
    ]
  }
  return [
    ...queue.steering.filter(visible).map((text) => ({ kind: 'steer' as const, text })),
    ...queue.followUp.filter(visible).map((text) => ({ kind: 'queue' as const, text }))
  ]
}

export function queueRowActions(row: QueuedRow, editable: boolean): QueueRowAction[] {
  if (!editable || !row.id || !row.digest) return []
  return row.kind === 'queue' ? ['steer', 'edit', 'remove'] : ['edit', 'remove']
}

export function queueOp(row: QueuedRow, action: QueueRowAction, text?: string): RemoteQueueOp | null {
  if (!row.id || !row.digest) return null
  if (action === 'edit') {
    const next = text?.trim()
    return next && next !== row.text ? { op: 'edit', id: row.id, expect: row.digest, text: next } : null
  }
  return { op: action, id: row.id, expect: row.digest }
}

export function withdrawAllOp(rows: QueuedRow[]): RemoteQueueOp | null {
  const items = rows.flatMap((row) => (row.id && row.digest ? [{ id: row.id, expect: row.digest }] : []))
  return items.length ? { op: 'clear', items } : null
}

export type SendChoice = 'steer' | 'followUp'

export type SendPlan = { action: 'hold' } | { action: 'send'; mode?: SendChoice }

export function composerSendPlan(state: { running: boolean; compacting: boolean; choice: SendChoice }): SendPlan {
  if (state.compacting) return { action: 'hold' }
  return state.running ? { action: 'send', mode: state.choice } : { action: 'send' }
}

export interface SubagentActionInput {
  status: 'starting' | 'running' | 'done' | 'error' | 'cancelled'
  endReason?: string
  resumable?: boolean
  review?: RemoteSubagentReview
  canMerge?: boolean
  canDiscard?: boolean
}

export function subagentActions(run: SubagentActionInput, caps: { review: boolean; send: boolean }): { merge: boolean; discard: boolean; send: boolean } {
  const live = run.status === 'starting' || run.status === 'running'
  const interrupted = run.status === 'cancelled' && run.endReason === 'interrupted'
  const reviewing = run.review === 'pending' || run.review === 'conflict'
  return {
    merge: caps.review && !live && run.canMerge === true,
    discard: caps.review && !live && run.canDiscard === true,
    send: caps.send && (live || (interrupted && run.resumable !== false) || reviewing)
  }
}
