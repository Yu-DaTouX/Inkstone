export interface PlanCardVisibility {
  hasTodos: boolean
  total: number
  done: number
  stale: boolean
  dismissed: boolean
}

export function planCardVisible(input: PlanCardVisibility): boolean {
  if (!input.hasTodos || input.dismissed) return false
  return !(input.total > 0 && input.done >= input.total && input.stale)
}

export function planCardKeyOf(snapshotId: string | null, todos: readonly { text: string; done: boolean; status?: string }[]): string {
  if (snapshotId) return snapshotId
  return todos.map((todo) => `${todo.done ? '1' : '0'}:${todo.status ?? ''}:${todo.text}`).join('\n')
}
