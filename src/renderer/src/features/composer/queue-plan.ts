import type { QueueItem, QueueState } from '../../../../shared/ipc'

type QueueKind = 'steering' | 'followUp'
type QueueMove = 'up' | 'down'

interface QueueLocation {
  kind: QueueKind
  index: number
  item: QueueItem
}

const KINDS: readonly QueueKind[] = ['steering', 'followUp']

export function locateQueueItem(state: QueueState, id: string): QueueLocation | undefined {
  for (const kind of KINDS) {
    const index = state[kind].findIndex((item) => item.id === id)
    if (index >= 0) return { kind, index, item: state[kind][index] }
  }
  return undefined
}

function replaceList(state: QueueState, kind: QueueKind, items: QueueItem[]): QueueState {
  return kind === 'steering'
    ? { steering: items, followUp: state.followUp }
    : { steering: state.steering, followUp: items }
}

export function planQueueMove(state: QueueState, id: string, direction: QueueMove): QueueState | null {
  const found = locateQueueItem(state, id)
  if (!found) return null
  const target = found.index + (direction === 'up' ? -1 : 1)
  const list = state[found.kind]
  if (target < 0 || target >= list.length) return null
  const items = [...list]
  const [moved] = items.splice(found.index, 1)
  items.splice(target, 0, moved)
  return replaceList(state, found.kind, items)
}

export function planQueueEdit(state: QueueState, id: string, text: string): QueueState | null {
  const found = locateQueueItem(state, id)
  if (!found) return null
  const next = text.trim()
  if (!next || next === found.item.text) return null
  const items = [...state[found.kind]]
  items[found.index] = { ...found.item, text: next }
  return replaceList(state, found.kind, items)
}

export function planQueueRemove(state: QueueState, id: string): QueueState | null {
  const found = locateQueueItem(state, id)
  if (!found) return null
  const items = state[found.kind].filter((item) => item.id !== id)
  return replaceList(state, found.kind, items)
}

export function planQueueClear(state: QueueState): QueueState | null {
  if (state.steering.length === 0 && state.followUp.length === 0) return null
  return { steering: [], followUp: [] }
}

export type QueueOp =
  | { op: 'move'; id: string; direction: QueueMove }
  | { op: 'edit'; id: string; text: string }
  | { op: 'remove'; id: string }
  | { op: 'clear' }

export function planQueueOp(state: QueueState, op: QueueOp): QueueState | null {
  switch (op.op) {
    case 'move':
      return planQueueMove(state, op.id, op.direction)
    case 'edit':
      return planQueueEdit(state, op.id, op.text)
    case 'remove':
      return planQueueRemove(state, op.id)
    case 'clear':
      return planQueueClear(state)
  }
}
