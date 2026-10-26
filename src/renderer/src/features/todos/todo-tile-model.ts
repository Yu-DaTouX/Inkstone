import type { SessionTodo } from '../../../../shared/ipc'

export type TodoRowKind = 'done' | 'running' | 'blocked' | 'pending'

export interface TodoTileRow {
  index: number
  text: string
  kind: TodoRowKind
}

export interface TodoTileModel {
  total: number
  done: number
  rows: TodoTileRow[]
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
  return { total: todos.length, done: todos.filter(isDone).length, rows, activeIndex }
}

export function activeTodoRow(model: TodoTileModel): TodoTileRow | undefined {
  return model.activeIndex >= 0 ? model.rows[model.activeIndex] : undefined
}

export function anchorTodoIndex(model: TodoTileModel): number {
  if (model.activeIndex >= 0) return model.activeIndex
  return model.rows.findIndex((row) => row.kind !== 'done')
}

