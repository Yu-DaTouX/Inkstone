/**
 * 侧栏待办磁贴的纯计算：完成度、每行状态、折叠记忆。
 *
 * 只吃普通数据，不读 store、不碰 DOM，便于单测钉住边界。数据的唯一来源是
 * `store.todos`（当前主视图会话，见 `state/push-routing.ts` 的 `belongsToView`），
 * 本模块不聚合别的会话，也不认识子代理。
 */
import type { SessionTodo } from '../../../../shared/ipc'

/** 一行在磁贴里的呈现状态：完成 / 进行中 / 受阻 / 待办。 */
export type TodoRowKind = 'done' | 'running' | 'blocked' | 'pending'

export interface TodoTileRow {
  /** 在原清单里的下标 —— 清单没有稳定 id，渲染 key 用它。 */
  index: number
  text: string
  kind: TodoRowKind
}

export interface TodoTileModel {
  total: number
  done: number
  rows: TodoTileRow[]
  /** 进行中那一行的下标；-1 = 没有正在做的（不猜出一条永远在转的）。 */
  activeIndex: number
}

/** 折叠状态按会话 id 记；true = 只剩标题行。内存态，不落设置。 */
export type TodoTileFolds = Readonly<Record<string, boolean>>

/** 有清单才占位置；空清单整块不渲染（无标题、无空态）。 */
export function hasTodoTileContent(todos: readonly SessionTodo[]): boolean {
  return todos.length > 0
}

/**
 * 是否算「已完成」。
 *
 * `done` 是清单的布尔完成位；`status === 'done'` 是 pi 侧显式状态。
 * 两者任一成立即完成，保证打勾数与 `完成/总数` 一致。
 */
function isDone(todo: SessionTodo): boolean {
  return todo.done || todo.status === 'done'
}

/**
 * 「正在做」的判定，与 v2 右栏同一套两步口径：
 *   ① 有显式 `status === 'running'` → 就是它；
 *   ② 清单里出现过任意 `status` → 以显式状态为准，没有 running 就返回 -1
 *      （老数据才退回推断，不把「还没做」猜成「正在做」）；
 *   ③ 只有 `{text, done}` 的老数据 → 退回「第一个未完成」，但要求回合真的在跑。
 */
function resolveActiveIndex(todos: readonly SessionTodo[], agentRunning: boolean): number {
  const explicit = todos.findIndex((todo) => todo.status === 'running')
  if (explicit >= 0) return explicit
  if (todos.some((todo) => todo.status !== undefined)) return -1
  if (!agentRunning) return -1
  return todos.findIndex((todo) => !isDone(todo))
}

/** 把清单投影成磁贴模型：计数 + 每行状态 + 进行中行。 */
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

/** 切换某条会话的折叠；空 sessionId 不落键，避免所有未识别会话串在一起。 */
export function toggleTodoTileFold(folds: TodoTileFolds, sessionId: string): TodoTileFolds {
  if (!sessionId) return folds
  return { ...folds, [sessionId]: folds[sessionId] !== true }
}
