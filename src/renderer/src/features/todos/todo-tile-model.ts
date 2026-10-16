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

export type TodoTileFolds = Readonly<Record<string, boolean>>

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
        : index === activeIndex
          ? 'running'
          : 'pending'
  }))
  return { total: todos.length, done: todos.filter(isDone).length, rows, activeIndex }
}

export function isTodoTileFolded(folds: TodoTileFolds, sessionId: string): boolean {
  return sessionId.length > 0 && folds[sessionId] === true
}

export function toggleTodoTileFold(folds: TodoTileFolds, sessionId: string): TodoTileFolds {
  if (!sessionId) return folds
  return { ...folds, [sessionId]: folds[sessionId] !== true }
}
