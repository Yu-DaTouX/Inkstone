type QueueMove = 'up' | 'down'

export type QueueOp =
  | { op: 'move'; id: string; direction: QueueMove }
  | { op: 'edit'; id: string; text: string }
  | { op: 'remove'; id: string }
  | { op: 'clear' }
