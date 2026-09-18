/**
 * 任务计划（task plan）的**契约层 + 纯逻辑**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这个文件里有什么
 * ══════════════════════════════════════════════════════════════════
 *  ① **形状与常量**：custom entry 标识、操作名、上限、条目结构；
 *  ② **输入解析与校验**（S2）：把不可信的模型参数变成确定的清单或**可读错误**；
 *  ③ **纯 reducer**（S2）：六个操作 + 不变性 + `revision` 递增 + `operationId` 幂等；
 *  ④ **历史读取**（S2）：旧载荷与宿主日志载荷 → 同一份结构。
 *
 * 它**不碰** electron / pi / 文件系统，也不 import pi 的任何内部模块 ——
 * 所以主进程、随包 `yan` CLI、单测能用同一份规则（实施-02 §5-S2）。
 *
 * ── 为什么要单独一个模块 ──
 * 以前「任务快照」的身份只写在 [todo-snapshots.ts](../main/todo-snapshots.ts) 里的一条正则
 * （`/task|todo/i`）。那意味着任何扩展写一个叫 `my-task-log` 的 custom entry、
 * 又恰好带 `{todos: [...]}`，就会被砚当成任务清单读出来并显示成「任务计划」——
 * 那不是兼容，是**冒充**（实施-02 §3：来源必须由受信清单决定）。
 * 所以身份判断收在这里，只认下面两个**精确**标识。
 *
 * ── 单写者原则（本契约最重要的一条）──
 * · 宿主新写入只走 [TASK_PLAN_CUSTOM_TYPE]；
 * · [LEGACY_TASK_CUSTOM_TYPE] 是**只读兼容**：旧扩展写的条目照读、照显示历史，
 *   但砚**永不回写**它，也不批量转换（实施-02 §4）。
 * 两条标识同时出现时，**宿主日志优先级更高**，旧条目只在那一轮没有宿主快照时显示。
 *
 * ── 两条贯穿全文的取舍 ──
 * · **宁可不猜**：认不出的显式状态、不是 boolean 的 `done`、对不上的 schema 版本，
 *   都不猜（报错或退化成保守值）—— 猜错的状态比没有状态更糟；
 * · **不静默截断**：超上限、越界、清单里的坏项都**报可读错误**，
 *   绝不「取前 200 条」了事（那会让模型以为写成功了，而用户看到的是另一份清单）。
 */
import type { TodoStatus } from './ipc'

/**
 * 旧扩展（用户本机的 `left-info-panel`）写入的任务快照标识。**只读兼容。**
 *
 * 保留它是为了「升级用户的旧会话仍看得到历史任务」，
 * 不代表还要用它写新数据 —— 新的写入走宿主日志。
 */
export const LEGACY_TASK_CUSTOM_TYPE = 'left-panel-tasks'

/**
 * 砚宿主任务日志的 custom entry 标识。
 *
 * S3 才真正写入；这里提前定下来，让解析、UI 来源判定与单测先有同一个真源。
 * 数据形状见 [TaskPlanEntryData]（**保留** `todos` 兼容字段）。
 */
export const TASK_PLAN_CUSTOM_TYPE = 'yan-task-plan'

/** 宿主日志条目的 schema 版本。版本不同时按「读不了就当没有」处理，不做静默猜测。 */
export const TASK_PLAN_SCHEMA_VERSION = 1

/** 模型可调用的六个操作（与旧扩展 `panel_todos` 的 action 集合一致）。 */
export const TASK_ACTIONS = ['set', 'add', 'complete', 'uncomplete', 'remove', 'clear'] as const
export type TaskAction = (typeof TASK_ACTIONS)[number]

/**
 * 上限（实施-02 §4）。
 *
 * 超过时**返回可读错误**，不悄悄截断 —— 静默截断会让模型以为自己写成功了，
 * 而用户在界面上看到的是另一份清单。
 */
export const TASK_PLAN_LIMITS = {
  /** 单份清单最多多少项。 */
  maxItems: 200,
  /** 单项文字最长多少字符（按 **code point** 数，CJK / emoji 都算一个）。 */
  maxTextLength: 2000
} as const

/** 一条任务（`status` 只在**认得出**的显式状态时才带，见 [normalizeTaskStatus]）。 */
export interface TaskItemShape {
  text: string
  done: boolean
  status?: TodoStatus
}

/**
 * 宿主任务日志条目的数据形状。
 *
 * `todos` 是**兼容字段**：旧扩展、旧解析器、界面都按它读；
 * `revision` / `operationId` 是宿主写入独有的账本信息，用来做幂等与冲突判断。
 */
export interface TaskPlanEntryData {
  schemaVersion: number
  /** 会话内单调递增；同一 `operationId` 重放**不得**再涨。 */
  revision: number
  /** 绑定「会话 + 一次工具调用」；重试不重复 `add`。 */
  operationId: string
  todos: TaskItemShape[]
}

/**
 * 这个 custom entry 标识是否属于「任务计划」。
 *
 * **精确匹配**，不用模糊正则：来源判定必须是受信清单（实施-02 §3）。
 */
export function isTaskPlanCustomType(customType: unknown): boolean {
  return customType === LEGACY_TASK_CUSTOM_TYPE || customType === TASK_PLAN_CUSTOM_TYPE
}

/**
 * 从 custom entry 的 `data` 里取出清单数组。
 *
 * 两种来源的形状在这里统一：旧扩展 `{todos}`、宿主日志 `{schemaVersion,…,todos}`。
 * 取不到就回 `undefined`（调用方跳过这一条），**不**用空数组顶替 ——
 * 「没有清单」与「清单被清空」是两件事。
 */
export function todoArrayOf(data: unknown): unknown[] | undefined {
  if (!data || typeof data !== 'object') return undefined
  const todos = (data as { todos?: unknown }).todos
  return Array.isArray(todos) ? todos : undefined
}

/* ══════════════════════════════════════════════════════════════════
 * 一、状态与请求
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 一份任务计划的**状态**（纯逻辑层；落盘在 S3）。
 *
 * 为什么不复用 [TaskPlanEntryData]：那是**写给会话文件**的形状（`schemaVersion` 必须在，
 * 因为读回来时要靠它判断能不能认）。内存里的状态不需要那个字段，
 * 少一个字段就少一处「忘了带版本号」的错。
 */
export interface TaskPlanState {
  todos: TaskItemShape[]
  /** 从 1 开始单调递增；0 = 还没有任何宿主写入（纯旧历史）。 */
  revision: number
  /** 产生当前 revision 的那次操作 id；没有（旧历史 / 初始态）为 `null`。 */
  operationId: string | null
}

/** 还没有任何宿主写入时的状态（空会话、或只有旧扩展历史）。 */
export function emptyTaskPlan(): TaskPlanState {
  return { todos: [], revision: 0, operationId: null }
}

/**
 * 一次写入请求。
 *
 * `operationId` 必填：它是**幂等的唯一依据**。宿主生成（绑定会话 + 工具调用），
 * 不由模型自报 —— 与 `yan` CLI 的身份校验同一套思路（01-S2）。
 */
export interface TaskPlanRequest {
  action: TaskAction
  /** `set` / `add` 用；其余操作忽略（但传了也不算错，模型经常照抄模板参数）。 */
  items?: unknown
  /** `complete` / `uncomplete` / `remove` 用，**从 1 开始**。 */
  index?: unknown
  operationId: string
}

/** 回执里的「实际变更项」——UI 与模型据此核对这次到底动了什么。 */
export interface TaskChange {
  kind: 'replaced' | 'added' | 'removed' | 'completed' | 'uncompleted' | 'cleared'
  /** 变更后的 1-based 序号（`replaced` / `cleared` 不带）。 */
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
      /** `true` = 这次请求与上一次提交是同一个 `operationId`，**没有**再改状态。 */
      replayed: boolean
    }
  | { ok: false; code: TaskErrorCode; message: string }

/* ══════════════════════════════════════════════════════════════════
 * 二、规范化（宽容：历史数据用）
 * ══════════════════════════════════════════════════════════════════ */

/**
 * pi 侧各样写法 → 这里的四种状态。
 *
 * 为什么要别名表而不是只认一个名字：写清单的是**扩展**（不在这个仓库里），
 * 它的字段名我们管不着（`in_progress` / `doing` / `active` 都见过）。
 * 认不出来的一律当**没有显式状态**（退回 `done` 推断），而不是塞一个猜的 ——
 * 猜错的状态比没有状态更糟。
 */
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

/** 认得出就给出状态，认不出回 `undefined`（**不猜**）。 */
export function normalizeTaskStatus(v: unknown): TodoStatus | undefined {
  if (typeof v !== 'string') return undefined
  return STATUS_ALIASES[v.trim().toLowerCase().replace(/[\s-]+/g, '_')]
}

/**
 * 一条**历史**记录 → 统一形状。文字为空 / 不是对象 → `undefined`（调用方丢掉它）。
 *
 * 为什么叫「规范化」而不是「校验」：这条路径读的是**别人写的旧数据**，
 * 我们只能尽量理解它，不能因为一个字段怪就让整份历史消失。
 * 新写入的**严格校验**在 [parseRequestItems]。
 */
export function normalizeTaskItem(raw: unknown): TaskItemShape | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const t = raw as { text?: unknown; done?: unknown; status?: unknown }
  const text = typeof t.text === 'string' ? t.text : t.text == null ? '' : String(t.text)
  if (text.length === 0) return undefined
  const status = normalizeTaskStatus(t.status)
  /* 两个字段不一致时以「完成」为准：勾上了就不该还在跑 */
  const done = status === 'done' || Boolean(t.done)
  /* 只在**认得出**显式状态时才带上它，否则保持老数据的形状 */
  return { text, done, ...(status ? { status: done ? ('done' as const) : status } : {}) }
}

/** 一份**历史**清单 → 统一形状（坏项丢掉，不因此丢掉整份历史）。 */
export function normalizeTaskItems(raw: unknown): TaskItemShape[] {
  if (!Array.isArray(raw)) return []
  const out: TaskItemShape[] = []
  for (const item of raw) {
    const normalized = normalizeTaskItem(item)
    if (normalized) out.push(normalized)
  }
  return out
}

/* ══════════════════════════════════════════════════════════════════
 * 三、历史读取（旧载荷 / 宿主日志 → 同一份结构）
 * ══════════════════════════════════════════════════════════════════ */

/** 从会话里读回来的一份计划（无论它当初是旧扩展写的还是宿主写的）。 */
export interface StoredTaskPlan {
  /** 旧载荷没有版本号，按 `0` 记（它是「宿主写入之前」的世界）。 */
  schemaVersion: number
  revision: number
  operationId: string | null
  todos: TaskItemShape[]
}

/**
 * 读一份 custom entry 的 `data`。
 *
 * 认不了就回 `undefined`（调用方跳过），**不**回一个空计划 ——
 * 「这份数据我不认识」与「这是一份空清单」必须能分开，
 * 否则一条坏数据会把用户整轮的任务历史显示成「已清空」。
 */
export function readTaskPlanEntry(data: unknown): StoredTaskPlan | undefined {
  const raw = todoArrayOf(data)
  if (!raw) return undefined
  const d = data as { schemaVersion?: unknown; revision?: unknown; operationId?: unknown }

  /* 有版本号就得对得上：未来格式的字段语义可能变了，按旧规则读会读歪 */
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

/* ══════════════════════════════════════════════════════════════════
 * 四、请求校验（严格：新写入用）
 * ══════════════════════════════════════════════════════════════════ */

/** 按 **code point** 数长度：`'👍'` 是 1 而不是 `String.length` 的 2。 */
function charLength(text: string): number {
  return [...text].length
}

function fail(code: TaskErrorCode, message: string): { ok: false; code: TaskErrorCode; message: string } {
  return { ok: false, code, message }
}

/**
 * 解析 `items`（`set` / `add` 的入参）。
 *
 * 与 [normalizeTaskItems] 的区别就是**这里不宽容**：
 * · 不是数组 → `bad_items`；
 * · 某一项不是对象 → `bad_items`（连带说出第几项，方便模型自己改）；
 * · `text` 不是字符串、或去掉空白后为空 → `empty_text`；
 * · 超过 2000 字符 → `text_too_long`；
 * · `done` 存在但不是 boolean → `bad_done`（**不**照搬旧扩展的 `Boolean(x)`：
 *   `Boolean('false') === true`，模型写 `"false"` 会得到相反的结果）。
 */
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

/**
 * 解析 `index`（**从 1 开始**）。
 *
 * 越界的判据要看**当前清单长度**，所以这个函数需要 `current`。
 * 越界**不得修改状态**（实施-02 §4）—— 由 [applyTaskRequest] 保证：校验不过就不 reduce。
 */
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

/**
 * 校验一次请求（不改变任何状态）。
 *
 * 单独导出是给 S3 的落盘层用的：**先校验、再落盘**，
 * 这样「校验失败」不会在磁盘上留下半个 revision。
 */
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
      /* `add` 空数组**拒绝**：它多半是模型漏了参数，静默成功会让用户以为加了东西 */
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

/* ══════════════════════════════════════════════════════════════════
 * 五、reducer
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 应用一次请求，返回**新状态**（纯函数：不修改 `prev`，也不碰全局）。
 *
 * 三条不变式（单测逐条钉住）：
 *  ① **幂等**：`operationId` 与上一次提交相同 → 原样返回 `prev`、`revision` 不涨、
 *     `changed` 为空、`replayed: true`。这是「重试不重复 add」的唯一实现点；
 *  ② **失败即不动**：任何校验失败都返回初始状态**不做部分修改**；
 *  ③ **revision 只在成功提交时 +1**（同一 `operationId` 重放不算新提交）。
 *
 * 为什么不在这里判「有没有实际变化」（例如把已经 done 的项再 complete 一次）：
 * 那会让「成功的空操作」与「重放」在回执上长得一样，调用方就没法区分
 * 「这次真的提交了但没变化」和「上一次已经做过」。实际变更项由 `changed` 如实回报。
 */
export function applyTaskRequest(prev: TaskPlanState, request: TaskPlanRequest): TaskPlanApplyResult {
  /* ① 幂等：同一个 operationId 只生效一次 */
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
      /* `set []` 就是清空（契约明文允许），与 `clear` 的区别只是回执说辞 */
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
        /*
         * 只改 `done`，并让 `status` 与它一致：
         * 留着旧的 `status: 'running'` 会让界面继续显示「正在进行」（RightPanel 以 status 优先）。
         */
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
      /* 校验已经挡掉未知操作；这里只是让 TS 穷尽检查认账 */
      return fail('unknown_action', `不认识的操作：${JSON.stringify(request.action)}`)
  }
}

/**
 * 把状态打包成**要写进会话文件**的载荷（S3 用）。
 *
 * 单独一个函数是为了让「写出去的东西」只有一处定义 ——
 * 写入方忘了带 `schemaVersion` 的话，读回来时就会按旧规则读歪，
 * 而那种错在真实会话里极难发现。
 */
export function toTaskPlanEntryData(state: TaskPlanState): TaskPlanEntryData {
  return {
    schemaVersion: TASK_PLAN_SCHEMA_VERSION,
    revision: state.revision,
    /*
     * `revision: 0`（从未提交过）不应该走到这里 —— 没什么可写。
     * 真走到了也只是一份空清单 + 空 operationId，读回来按「旧历史」处理（`null`），
     * 比抛异常把调用方挂在写入路径上更安全。
     */
    operationId: state.operationId ?? '',
    todos: state.todos
  }
}

/** 一份**读回来**的旧载荷 / 宿主载荷 → 内存状态（写入方的 CAS 起点）。 */
export function planStateOf(stored: StoredTaskPlan): TaskPlanState {
  return { todos: stored.todos, revision: stored.revision, operationId: stored.operationId }
}

/* ══════════════════════════════════════════════════════════════════
 * 六、宿主任务日志（S3 的写入侧形状）
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 宿主任务日志里的一行。
 *
 * ── 为什么是「一行一次提交」而不是「一份最新状态」 ──
 *   界面要按轮次显示**历史快照**（旧扩展当年是每提交一次就 appendEntry 一条）。
 *   只留最新状态的话，升级用户的历史只剩最后一轮，
 *   而「跳回当时那轮对话」的入口会指向一份根本不存在的清单。
 *   文件本身只**追加**、不改写（见 src/main/task-plan-store.ts）。
 *
 * ── 为什么 `round` / `at` 在 `data` 外面 ──
 *   `data` 是要写进会话文件那条 custom entry 的形状（契约层，跨实现共用）；
 *   轮次与时间只对**宿主日志**有意义（按轮次归并、诊断），
 *   塞进 `data` 会让将来真写进会话文件的载荷多出两个没人读的字段。
 */
export interface TaskPlanLogRecord {
  /** 记录 id：等于这次提交的 `operationId`；仅用于界面 key 与诊断。 */
  id: string
  /** 这次提交发生在第几轮用户消息（与界面历史分组同口径，从 1 开始）。 */
  round: number
  /** 提交时间（ISO 字符串）。纯诊断，**读回时不做任何判断**。 */
  at: string
  /** 提交后的完整清单 + 账本字段（与写给会话文件的载荷同形）。 */
  data: TaskPlanEntryData
}

/**
 * 解析任务日志的一行。
 *
 * **宽容**（与历史读取同一立场）：空行、坏 JSON、认不出的 `data` 都回 `undefined`，
 * 调用方跳过它继续读后面的行 —— 一行坏数据不该让整份任务历史消失。
 * 注意这与「新写入严格」不矛盾：这条路径读的是**已经落盘的东西**。
 */
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

/** 一行日志的序列化（**不带**换行 —— 换行由写入方补，保证一行一条）。 */
export function serializeTaskPlanLogRecord(record: TaskPlanLogRecord): string {
  return JSON.stringify(record)
}

/**
 * 日志记录 → 会话条目形状，喂给 [todoSnapshotsFromEntries](../main/todo-snapshots.ts) 的归并。
 *
 * 为什么伪造条目形状而不是另写一份归并：轮次归并、同轮宿主优先、相邻轮合并这三条规则
 * 已经在那边钉住并被单测覆盖。宿主日志与旧条目**必须**走同一套规则，
 * 否则同一份会话在「有宿主日志」与「只有旧条目」两种状态下会显示出不同的历史 ——
 * 那是最难查的一类不一致。
 * `round` 由记录自带（旧条目的轮次要数用户消息才能得到，见那边的实现）。
 */
export function taskPlanLogEntry(record: TaskPlanLogRecord): Record<string, unknown> {
  return {
    id: record.id,
    type: 'custom',
    customType: TASK_PLAN_CUSTOM_TYPE,
    data: record.data,
    round: record.round
  }
}
