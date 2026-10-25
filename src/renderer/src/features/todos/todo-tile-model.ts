import type { SessionTodo } from '../../../../shared/ipc'

export type TodoRowKind = 'done' | 'running' | 'blocked' | 'pending'

export interface TodoTileRow {
  index: number
  text: string
  kind: TodoRowKind
}

export const TODO_TILE_VISIBLE_LIMIT = 6

export interface TodoTileModel {
  total: number
  done: number
  rows: TodoTileRow[]
  visibleRows: TodoTileRow[]
  activeIndex: number
}

export function hasTodoTileContent(todos: readonly SessionTodo[]): boolean {
  return todos.length > 0
}

function isDone(todo: SessionTodo): boolean {
  return todo.done || todo.status === 'done'
}

function resolveActiveIndex(todos: readonly SessionTodo[], agentRunning: boolean): number {
  const explicit = todos.findIndex((todo) => todo.status === 'running')
  if (explicit >= 0) return explicit
  if (todos.some((todo) => todo.status !== undefined)) return -1
  if (!agentRunning) return -1
  return todos.findIndex((todo) => !isDone(todo))
}

export function buildTodoTileModel(todos: readonly SessionTodo[], agentRunning: boolean): TodoTileModel {
  const activeIndex = resolveActiveIndex(todos, agentRunning)
  const rows: TodoTileRow[] = todos.map((todo, index) => ({
    index,
    text: todo.text,
    kind: isDone(todo)
      ? 'done'
      : todo.status === 'blocked'
        ? 'blocked'
        : todo.status === 'running' || index === activeIndex
          ? 'running'
          : 'pending'
  }))
  const focusIndex = activeIndex >= 0 ? activeIndex : rows.findIndex((row) => row.kind !== 'done')
  const start = Math.max(0, Math.min(focusIndex - 1, rows.length - TODO_TILE_VISIBLE_LIMIT))
  const visibleRows = rows.slice(start, start + TODO_TILE_VISIBLE_LIMIT)
  return { total: todos.length, done: todos.filter(isDone).length, rows, visibleRows, activeIndex }
}

