import type { SessionTodoSnapshot } from '../shared/ipc'
import {
  isTaskPlanCustomType,
  normalizeTaskItems,
  TASK_PLAN_CUSTOM_TYPE,
  todoArrayOf
} from '../shared/task-plan'

/**
 * 从会话的 custom entries（以及**宿主任务日志**转成的同形条目）里抽任务清单快照。
 *
 * 两种来源（契约见 `shared/task-plan.ts`）：
 *   · `left-panel-tasks` —— 旧 `left-info-panel` 扩展写的，形状 `{ todos: {text, done}[] }`，**只读兼容**；
 *   · `yan-task-plan` —— 砚宿主任务日志（S3 写入）：真身在 `YAN_DIR/task-plans/<sessionId>.jsonl`，
 *     由 agent 的 `refreshTodos` 用 `taskPlanLogEntry()` 转成同形条目喂进来（**带轮次**）。
 * 其它 customType **一律不算任务**（不看名字里有没有 task/todo，那是冒充的来源）。
 *
 * 「一条载荷 → 统一条目」的规则在 `shared/task-plan.ts`（`normalizeTaskItems`）：
 * 那里连 `yan` CLI 也要用，而**轮次归并只属于界面历史**，所以留在本文件。
 *
 * 旧扩展在一轮里**随进度反复写**（0/6 → 1/7 → 7/7 之类），
 * 所以原始 entry 里有很多同一轮、不同进度的快照。
 *
 * 历史任务要展示的是「每一轮最终的清单」，不是每一个中间态。
 * 因此这里：
 *   ① 按轮次归并，一轮只留**最后**一份；
 *   ② 相邻轮次内容完全相同时合并（列表没变就不算新历史），保留更近的一轮。
 *
 * `round`：这份清单在第几轮写的 —— 数它前面有多少条用户消息即可，
 * 与 UI 的回合分组口径一致。有了它，「跳转到那次任务的对话」才能真的跳。
 *
 * 这个模块是**纯函数**（不碰 electron / pi），方便单测钉住归并规则。
 */
export function todoSnapshotsFromEntries(
  entries: Record<string, unknown>[]
): SessionTodoSnapshot[] {
  /** round → 该轮胜出的快照 + 它是不是宿主日志（宿主优先，见下面的合并规则） */
  const byRound = new Map<number, { snapshot: SessionTodoSnapshot; host: boolean }>()
  let userMsgs = 0

  for (const e of entries) {
    // 先算轮次：遇到用户消息就 +1，之后写的清单属于「第 userMsgs 轮」
    if (e.type === 'message') {
      const m = e.message as { role?: unknown } | undefined
      if (m?.role === 'user') userMsgs++
      continue
    }
    if (e.type !== 'custom') continue

    const ct = String(e.customType ?? '')
    // 只认契约里那两个精确标识 —— 模糊匹配会让别的扩展的 entry 冒充任务
    if (!isTaskPlanCustomType(ct)) continue
    const host = ct === TASK_PLAN_CUSTOM_TYPE

    const raw = todoArrayOf(e.data)
    if (!raw) continue

    /* 逐条规范化（坏项丢掉，不因此丢掉整份历史）；空清单不算一份历史 */
    const todos = normalizeTaskItems(raw)
    if (todos.length === 0) continue

    /*
     * 轮次：
     *   · 宿主任务日志（`yan-task-plan`）在写入时就记下了当时的轮次，**直接采信** ——
     *     它落盘时与算它的那一刻可能隔着别的会话动作，靠条目的位置反推会算歪；
     *   · 旧扩展条目是写进会话文件的，位置本身就是真话，照旧数它前面有几条用户消息。
     */
    const round =
      host && typeof e.round === 'number' && Number.isInteger(e.round) && e.round >= 1
        ? e.round
        : Math.max(1, userMsgs)
    /*
     * 同一轮里两种来源都写了时**宿主日志优先**（契约里的单写者原则）。
     * 不能只靠「后写的覆盖先写的」：宿主条目与旧扩展条目谁先落盘取决于
     * 两个进程的时序，那等于掷骰子。
     */
    const prev = byRound.get(round)
    if (prev?.host && !host) continue
    byRound.set(round, { snapshot: { id: String(e.id ?? `t${round}`), todos, round }, host })
  }

  // 按轮次升序（更早的在前）
  const groups = [...byRound.values()].map((v) => v.snapshot).sort((a, b) => a.round - b.round)

  // 相邻且内容完全相同的轮次合并，保留更近的一轮
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

/** 两份任务清单是否完全一致（顺序、文字、完成态都要一样） */
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
