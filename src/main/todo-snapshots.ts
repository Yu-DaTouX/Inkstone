import type { SessionTodoSnapshot } from '../shared/ipc'
import {
  isTaskPlanCustomType,
  normalizeTaskItems,
  TASK_PLAN_CUSTOM_TYPE,
  todoArrayOf
} from '../shared/task-plan'

export function todoSnapshotsFromEntries(
  entries: Record<string, unknown>[]
): SessionTodoSnapshot[] {
  const byRound = new Map<number, { snapshot: SessionTodoSnapshot; host: boolean }>()
  let userMsgs = 0

  for (const e of entries) {
    if (e.type === 'message') {
      const m = e.message as { role?: unknown } | undefined
      if (m?.role === 'user') userMsgs++
      continue
    }
    if (e.type !== 'custom') continue

    const ct = String(e.customType ?? '')
    if (!isTaskPlanCustomType(ct)) continue
    const host = ct === TASK_PLAN_CUSTOM_TYPE

    const raw = todoArrayOf(e.data)
    if (!raw) continue

    const todos = normalizeTaskItems(raw)
    if (todos.length === 0) continue

    const round =
      host && typeof e.round === 'number' && Number.isInteger(e.round) && e.round >= 1
        ? e.round
        : Math.max(1, userMsgs)
    const prev = byRound.get(round)
    if (prev?.host && !host) continue
    byRound.set(round, { snapshot: { id: String(e.id ?? `t${round}`), todos, round }, host })
  }

  const groups = [...byRound.values()].map((v) => v.snapshot).sort((a, b) => a.round - b.round)

  const out: SessionTodoSnapshot[] = []
  for (const g of groups) {
    const prev = out[out.length - 1]
    if (prev && sameTodos(prev.todos, g.todos)) {
      out[out.length - 1] = g
      continue
    }
    out.push(g)
  }
  return out
}

export function sameTodos(
  a: { text: string; done: boolean }[],
  b: { text: string; done: boolean }[]
): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].text !== b[i].text || a[i].done !== b[i].done) return false
  }
  return true
}
