/**
 * 任务收件箱的 IPC 适配（`yan:taskinbox:*`）：会话 × 运行实例 × 任务计划的只读投影。
 *
 * 忽略名单与「看过」时间存在 `YAN_DIR/task-inbox.json`，这里持一份内存副本，
 * 写入时同步更新（投影的 `dismissed()` 是同步调用）。
 */
import type { IpcRegistrar } from './registrar'
import { questionLog } from '../question-log'
import { createTaskInboxService } from '../task-inbox-service'
import { createTaskInboxSources, readInboxState, writeInboxState } from '../task-inbox-sources'
import type { TaskInboxQuery } from '../../shared/task-inbox'
import { currentTaskPlan } from '../task-plan-store'
import type { RunnerStatus } from '../../shared/ipc'

export interface TaskInboxIpcDeps {
  /** 运行实例快照（运行注册表可能在注册后才建立，取快照时再问） */
  runnerStatuses(): RunnerStatus[]
}

export function registerTaskInboxIpc(ipc: IpcRegistrar, deps: TaskInboxIpcDeps): void {
  const { handle } = ipc
  const { runnerStatuses } = deps
  /*
   * 任务收件箱（实施-28 T2）：会话 × 运行实例 × 任务计划的**只读**投影。
   *
   * ── 为什么要缓存忽略名单 ──
   *   契约里 `dismissed()` 是同步的（投影是纯函数，不能 await），
   *   而名单存在 `YAN_DIR/task-inbox.json`。所以在这里持一份内存副本，
   *   写入时同步更新 —— 不把可变状态放进 sources 模块（两个实例会互踩）。
   */
  let inboxDismissed: string[] | null = null
  /* 「我上次看过它」的时间（收件箱近似判「跑完了没被确认」的唯一依据） */
  let inboxReadUntil: Record<string, number> = {}
  const inboxService = createTaskInboxService(
    createTaskInboxSources({
      registry: { statuses: runnerStatuses },
      dismissed: () => inboxDismissed ?? [],
      /* T3：等用户回答 —— 问答记录的最后一条没作答也没取消 */
      questionLog,
      /*
       * T4：「跑完了但没被确认」——这是七态里唯一的近似，所以卡片会带上 approximate。
       * 两个条件都要满足（缺一个都会误报）：
       *   ① 我看过它之后又有活动（否则就是我看过、已经知道结果了）；
       *   ② 计划里的步骤全完（否则还在做，不该催我确认）。
       */
      awaitingReview: async (sessionId, session) => {
        const seen = inboxReadUntil[sessionId] ?? 0
        if (session.updatedAt <= seen) return undefined
        try {
          const { state } = await currentTaskPlan(sessionId)
          if (!state.todos.length) return undefined
          if (state.todos.some((todo) => !todo.done && todo.status !== 'done')) return undefined
        } catch {
          return undefined
        }
        return { since: session.updatedAt, reason: '计划里的步骤都跑完了，你还没看结果' }
      }
    })
  )
  const inboxState = async (): Promise<string[]> => {
    if (!inboxDismissed) {
      const state = await readInboxState()
      inboxDismissed = state.dismissed
      inboxReadUntil = state.readUntil
    }
    return inboxDismissed
  }
  handle('yan:taskinbox:page', async (query?: TaskInboxQuery) => {
    await inboxState()
    const { limit, offset, ...filter } = query ?? {}
    return inboxService.page(filter, { limit, offset })
  })
  handle('yan:taskinbox:dismiss', async (sessionId: string) => {
    const list = await inboxState()
    const id = String(sessionId ?? '')
    if (id && !list.includes(id)) {
      inboxDismissed = [...list, id]
      await writeInboxState({ dismissed: inboxDismissed, readUntil: inboxReadUntil })
      /* 名单变了要让下一次查询重算（TTL 缓存里还带着它） */
      inboxService.invalidate()
    }
    return { ok: Boolean(id), dismissed: inboxDismissed ?? [] }
  })
  handle('yan:taskinbox:restore', async (sessionId: string) => {
    const list = await inboxState()
    const id = String(sessionId ?? '')
    if (id) {
      inboxDismissed = list.filter((x) => x !== id)
      await writeInboxState({ dismissed: inboxDismissed, readUntil: inboxReadUntil })
      inboxService.invalidate()
    }
    return { ok: Boolean(id), dismissed: inboxDismissed ?? [] }
  })
  /*
   * 「我看过了」（T4）：打开会话时调一次，收件箱就不再把「跑完了」报成待确认。
   * 它只记时间戳，不动会话数据 —— 不写这条最多是多重提醒一次，不会丢信息。
   */
  handle('yan:taskinbox:seen', async (sessionId: string) => {
    await inboxState()
    const id = String(sessionId ?? '')
    if (!id) return { ok: false }
    inboxReadUntil = { ...inboxReadUntil, [id]: Date.now() }
    await writeInboxState({ dismissed: inboxDismissed ?? [], readUntil: inboxReadUntil })
    inboxService.invalidate()
    return { ok: true }
  })
}
