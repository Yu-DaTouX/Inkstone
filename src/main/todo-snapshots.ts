import type { SessionTodoSnapshot, TodoStatus } from '../shared/ipc'

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

function toStatus(v: unknown): TodoStatus | undefined {
  if (typeof v !== 'string') return undefined
  return STATUS_ALIASES[v.trim().toLowerCase().replace(/[\s-]+/g, '_')]
}

/**
 * 从会话的 custom entries 里抽任务清单快照。
 *
 * `left-info-panel` 用 `pi.appendEntry('left-info-panel-tasks', {todos})` 写，
 * 形状是 `{ todos: {text, done}[] }`。它**在一轮里会随进度反复写**
 * （0/6 → 1/7 → 7/7 之类），所以原始 entry 里有很多同一轮、不同进度的快照。
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
  // round → 该轮最后一份快照（Map.set 天然让后写的覆盖先写的）
  const byRound = new Map<number, SessionTodoSnapshot>()
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
    // 认不出名字的 custom entry 不当任务 —— 不能把所有 custom entry 都算进来
    if (!/task|todo/i.test(ct)) continue

    const data = e.data as { todos?: unknown } | undefined
    if (!Array.isArray(data?.todos)) continue

    const todos = data.todos
      .filter(
        (t): t is { text?: unknown; done?: unknown; status?: unknown } => !!t && typeof t === 'object'
      )
      .map((t) => {
        const status = toStatus(t.status)
        /* 两个字段不一致时以「完成」为准：勾上了就不该还在跑 */
        const done = status === 'done' || Boolean(t.done)
        /* 只在**认得出**显式状态时才带上它，否则保持老数据的形状 */
        return {
          text: String(t.text ?? ''),
          done,
          ...(status ? { status: done ? ('done' as const) : status } : {})
        }
      })
      .filter((t) => t.text.length > 0)
    if (todos.length === 0) continue

    const round = Math.max(1, userMsgs)
    byRound.set(round, { id: String(e.id ?? `t${round}`), todos, round })
  }

  // 按轮次升序（更早的在前）
  const groups = [...byRound.values()].sort((a, b) => a.round - b.round)

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
