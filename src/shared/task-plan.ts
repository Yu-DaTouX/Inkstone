import type { TodoStatus } from './ipc'

export const LEGACY_TASK_CUSTOM_TYPE = 'left-panel-tasks'

export const TASK_PLAN_CUSTOM_TYPE = 'yan-task-plan'

export const TASK_PLAN_SCHEMA_VERSION = 1

export const TASK_ACTIONS = ['set', 'add', 'complete', 'uncomplete', 'remove', 'clear'] as const
export type TaskAction = (typeof TASK_ACTIONS)[number]

export const TASK_PLAN_LIMITS = {
  maxItems: 20,
  maxTextLength: 80
} as const

export interface TaskItemShape {
  text: string
  done: boolean
  status?: TodoStatus
}

export interface TaskPlanEntryData {
  schemaVersion: number
  revision: number
  operationId: string
  todos: TaskItemShape[]
}

export function isTaskPlanCustomType(customType: unknown): boolean {
  return customType === LEGACY_TASK_CUSTOM_TYPE || customType === TASK_PLAN_CUSTOM_TYPE
}

export function todoArrayOf(data: unknown): unknown[] | undefined {
  if (!data || typeof data !== 'object') return undefined
  const todos = (data as { todos?: unknown }).todos
  return Array.isArray(todos) ? todos : undefined
}

export interface TaskPlanState {
  todos: TaskItemShape[]
  revision: number
  operationId: string | null
}

export function emptyTaskPlan(): TaskPlanState {
  return { todos: [], revision: 0, operationId: null }
}

export interface TaskPlanRequest {
  action: TaskAction
  items?: unknown
  index?: unknown
  operationId: string
}

export interface TaskChange {
  kind: 'replaced' | 'added' | 'removed' | 'completed' | 'uncompleted' | 'cleared'
  index?: number
  text?: string
}

export type TaskErrorCode =
  | 'missing_operation_id'
  | 'unknown_action'
  | 'bad_items'
  | 'empty_text'
  | 'text_too_long'
  | 'bad_done'
  | 'too_many_items'
  | 'bad_index'
  | 'index_out_of_range'
  | 'empty_add'

export type TaskPlanApplyResult =
  | {
      ok: true
      state: TaskPlanState
      changed: TaskChange[]
      replayed: boolean
    }
  | { ok: false; code: TaskErrorCode; message: string }

const STATUS_ALIASES: Record<string, TodoStatus> = {
  pending: 'pending',
  todo: 'pending',
  open: 'pending',
  not_started: 'pending',
  in_progress: 'running',
  running: 'running',
  doing: 'running',
  active: 'running',
  completed: 'done',
  complete: 'done',
  done: 'done',
  finished: 'done',
  blocked: 'blocked',
  failed: 'blocked',
  error: 'blocked'
}

export function normalizeTaskStatus(v: unknown): TodoStatus | undefined {
  if (typeof v !== 'string') return undefined
  return STATUS_ALIASES[v.trim().toLowerCase().replace(/[\s-]+/g, '_')]
}

export function normalizeTaskItem(raw: unknown): TaskItemShape | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const t = raw as { text?: unknown; done?: unknown; status?: unknown }
  const text = typeof t.text === 'string' ? t.text : t.text == null ? '' : String(t.text)
  if (text.length === 0) return undefined
  const status = normalizeTaskStatus(t.status)
  const done = status === 'done' || t.done === true
  return { text, done, ...(status ? { status: done ? ('done' as const) : status } : {}) }
}

export function normalizeTaskItems(raw: unknown): TaskItemShape[] {
  if (!Array.isArray(raw)) return []
  const out: TaskItemShape[] = []
  for (const item of raw) {
    const normalized = normalizeTaskItem(item)
    if (normalized) out.push(normalized)
  }
  return out
}

export interface StoredTaskPlan {
  schemaVersion: number
  revision: number
  operationId: string | null
  todos: TaskItemShape[]
}

export function readTaskPlanEntry(data: unknown): StoredTaskPlan | undefined {
  const raw = todoArrayOf(data)
  if (!raw) return undefined
  const d = data as { schemaVersion?: unknown; revision?: unknown; operationId?: unknown }

  if (d.schemaVersion !== undefined && d.schemaVersion !== TASK_PLAN_SCHEMA_VERSION) return undefined

  const revision = Number.isInteger(d.revision) && (d.revision as number) >= 0 ? (d.revision as number) : 0
  const operationId = typeof d.operationId === 'string' && d.operationId.trim() ? d.operationId : null
  return {
    schemaVersion: typeof d.schemaVersion === 'number' ? d.schemaVersion : 0,
    revision,
    operationId,
    todos: normalizeTaskItems(raw)
  }
}

function charLength(text: string): number {
  return [...text].length
}

function fail(code: TaskErrorCode, message: string): { ok: false; code: TaskErrorCode; message: string } {
  return { ok: false, code, message }
}

export function parseRequestItems(
  raw: unknown
): { ok: true; items: TaskItemShape[] } | { ok: false; code: TaskErrorCode; message: string } {
  if (!Array.isArray(raw)) return fail('bad_items', 'items 必须是数组')
  const items: TaskItemShape[] = []
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i]
    const at = i + 1
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return fail('bad_items', `第 ${at} 项不是任务对象`)
    }
    const t = item as { text?: unknown; done?: unknown }
    if (typeof t.text !== 'string') return fail('empty_text', `第 ${at} 项缺少 text（必须是字符串）`)
    if (t.text.trim().length === 0) return fail('empty_text', `第 ${at} 项的 text 是空的`)
    if (charLength(t.text) > TASK_PLAN_LIMITS.maxTextLength) {
      return fail(
        'text_too_long',
        `第 ${at} 项超过 ${TASK_PLAN_LIMITS.maxTextLength} 字符（实际 ${charLength(t.text)}）`
      )
    }
    if (t.done !== undefined && typeof t.done !== 'boolean') {
      return fail('bad_done', `第 ${at} 项的 done 必须是 true / false`)
    }
    items.push({ text: t.text, done: t.done === true })
  }
  return { ok: true, items }
}

function parseIndex(
  raw: unknown,
  current: TaskPlanState
): { ok: true; index: number } | { ok: false; code: TaskErrorCode; message: string } {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    return fail('bad_index', `index 必须是从 1 开始的整数（收到 ${JSON.stringify(raw)}）`)
  }
  if (raw > current.todos.length) {
    return fail(
      'index_out_of_range',
      `index 越界：清单里只有 ${current.todos.length} 项（收到 ${raw}）`
    )
  }
  return { ok: true, index: raw }
}

export function validateTaskRequest(
  request: TaskPlanRequest,
  current: TaskPlanState
): { ok: true } | { ok: false; code: TaskErrorCode; message: string } {
  if (typeof request.operationId !== 'string' || request.operationId.trim().length === 0) {
    return fail('missing_operation_id', '缺少 operationId（幂等必须靠它，不能由模型自报身份）')
  }
  if (!TASK_ACTIONS.includes(request.action)) {
    return fail('unknown_action', `不认识的操作：${JSON.stringify(request.action)}`)
  }

  switch (request.action) {
    case 'clear':
      return { ok: true }
    case 'add':
    case 'set': {
      const parsed = parseRequestItems(request.items)
      if (!parsed.ok) return parsed
      if (request.action === 'add' && parsed.items.length === 0) {
        return fail('empty_add', 'add 至少要给一项（要清空请用 clear / set []）')
      }
      const total = request.action === 'set' ? parsed.items.length : current.todos.length + parsed.items.length
      if (total > TASK_PLAN_LIMITS.maxItems) {
        return fail(
          'too_many_items',
          `清单最多 ${TASK_PLAN_LIMITS.maxItems} 项，这次会变成 ${total} 项`
        )
      }
      return { ok: true }
    }
    case 'complete':
    case 'uncomplete':
    case 'remove': {
      const parsed = parseIndex(request.index, current)
      return parsed.ok ? { ok: true } : parsed
    }
  }
}

export function applyTaskRequest(prev: TaskPlanState, request: TaskPlanRequest): TaskPlanApplyResult {
  if (request.operationId && prev.operationId === request.operationId) {
    return { ok: true, state: prev, changed: [], replayed: true }
  }

  const valid = validateTaskRequest(request, prev)
  if (!valid.ok) return valid

  const nextRevision = prev.revision + 1
  const commit = (todos: TaskItemShape[], changed: TaskChange[]): TaskPlanApplyResult => ({
    ok: true,
    state: { todos, revision: nextRevision, operationId: request.operationId },
    changed,
    replayed: false
  })

  switch (request.action) {
    case 'set': {
      const parsed = parseRequestItems(request.items)
      if (!parsed.ok) return parsed
      return commit(parsed.items, [{ kind: 'replaced' }])
    }
    case 'add': {
      const parsed = parseRequestItems(request.items)
      if (!parsed.ok) return parsed
      const offset = prev.todos.length
      return commit(
        [...prev.todos, ...parsed.items],
        parsed.items.map((item, i) => ({ kind: 'added' as const, index: offset + i + 1, text: item.text }))
      )
    }
    case 'clear': {
      return commit([], [{ kind: 'cleared' }])
    }
    case 'complete':
    case 'uncomplete': {
      const parsed = parseIndex(request.index, prev)
      if (!parsed.ok) return parsed
      const done = request.action === 'complete'
      const todos = prev.todos.map((item, i) => {
        if (i !== parsed.index - 1) return item
        return done
          ? ({ ...item, done: true, status: 'done' } as TaskItemShape)
          : ({ text: item.text, done: false, status: 'pending' } as TaskItemShape)
      })
      return commit(todos, [
        {
          kind: done ? 'completed' : 'uncompleted',
          index: parsed.index,
          text: prev.todos[parsed.index - 1]?.text
        }
      ])
    }
    case 'remove': {
      const parsed = parseIndex(request.index, prev)
      if (!parsed.ok) return parsed
      const removed = prev.todos[parsed.index - 1]
      const todos = prev.todos.filter((_, i) => i !== parsed.index - 1)
      return commit(todos, [{ kind: 'removed', index: parsed.index, text: removed?.text }])
    }
    default:
      return fail('unknown_action', `不认识的操作：${JSON.stringify(request.action)}`)
  }
}

export function toTaskPlanEntryData(state: TaskPlanState): TaskPlanEntryData {
  return {
    schemaVersion: TASK_PLAN_SCHEMA_VERSION,
    revision: state.revision,
    operationId: state.operationId ?? '',
    todos: state.todos
  }
}

export function planStateOf(stored: StoredTaskPlan): TaskPlanState {
  return { todos: stored.todos, revision: stored.revision, operationId: stored.operationId }
}

export interface TaskPlanLogRecord {
  id: string
  round: number
  at: string
  data: TaskPlanEntryData
}

export function parseTaskPlanLogLine(line: string): TaskPlanLogRecord | undefined {
  const text = line.trim()
  if (!text) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as { id?: unknown; round?: unknown; at?: unknown; data?: unknown }
  if (!readTaskPlanEntry(r.data)) return undefined
  const round = Number.isInteger(r.round) && (r.round as number) >= 1 ? (r.round as number) : 1
  return {
    id: typeof r.id === 'string' && r.id.trim() ? r.id : '',
    round,
    at: typeof r.at === 'string' ? r.at : '',
    data: r.data as TaskPlanEntryData
  }
}

export function serializeTaskPlanLogRecord(record: TaskPlanLogRecord): string {
  return JSON.stringify(record)
}

export function taskPlanLogEntry(record: TaskPlanLogRecord): Record<string, unknown> {
  return {
    id: record.id,
    type: 'custom',
    customType: TASK_PLAN_CUSTOM_TYPE,
    data: record.data,
    round: record.round
  }
}
