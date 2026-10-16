import type { IpcRegistrar } from './registrar'
import { questionLog } from '../question-log'
import { createTaskInboxService } from '../task-inbox-service'
import { createTaskInboxSources, readInboxState, writeInboxState } from '../task-inbox-sources'
import type { TaskInboxQuery } from '../../shared/task-inbox'
import { currentTaskPlan } from '../task-plan-store'
import type { RunnerStatus } from '../../shared/ipc'

export interface TaskInboxIpcDeps {
  runnerStatuses(): RunnerStatus[]
}

export function registerTaskInboxIpc(ipc: IpcRegistrar, deps: TaskInboxIpcDeps): void {
  const { handle } = ipc
  const { runnerStatuses } = deps
  let inboxDismissed: string[] | null = null
  let inboxLoading: Promise<void> | null = null
  let writeTail: Promise<unknown> = Promise.resolve()
  let pageTail: Promise<unknown> = Promise.resolve()
  let pageStatuses: RunnerStatus[] | null = null
  let inboxReadUntil: Record<string, number> = {}
  const inboxService = createTaskInboxService(
    createTaskInboxSources({
      registry: { statuses: () => pageStatuses ?? runnerStatuses() },
      dismissed: () => inboxDismissed ?? [],
      questionLog,
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
      inboxLoading ??= readInboxState().then((state) => { inboxDismissed = state.dismissed; inboxReadUntil = state.readUntil })
      try { await inboxLoading } catch (error) { inboxLoading = null; throw error }
    }
    return inboxDismissed ?? []
  }
  const updateInbox = <T>(change: () => Promise<T>): Promise<T> => {
    const operation = async () => { await inboxState(); return change() }
    const next = writeTail.then(operation, operation)
    writeTail = next.catch(() => undefined)
    return next
  }
  handle('yan:taskinbox:page', (query?: TaskInboxQuery) => {
    const job = async () => {
      await inboxState()
      pageStatuses = runnerStatuses().map((status) => ({ ...status }))
      try {
        const { limit, offset, ...filter } = query ?? {}
        return await inboxService.page(filter, { limit, offset })
      } finally { pageStatuses = null }
    }
    const next = pageTail.then(job, job)
    pageTail = next.catch(() => undefined)
    return next
  })
  handle('yan:taskinbox:dismiss', (sessionId: string) => updateInbox(async () => {
    const list = inboxDismissed ?? []
    const id = String(sessionId ?? '')
    if (id && !list.includes(id)) {
      const candidate = [...list, id]
      const persisted = await writeInboxState({ dismissed: candidate, readUntil: inboxReadUntil })
      inboxDismissed = persisted.dismissed
      inboxReadUntil = persisted.readUntil
      inboxService.invalidate()
    }
    return { ok: Boolean(id), dismissed: inboxDismissed ?? [] }
  }))
  handle('yan:taskinbox:restore', (sessionId: string) => updateInbox(async () => {
    const list = inboxDismissed ?? []
    const id = String(sessionId ?? '')
    if (id) {
      const candidate = list.filter((x) => x !== id)
      const persisted = await writeInboxState({ dismissed: candidate, readUntil: inboxReadUntil })
      inboxDismissed = persisted.dismissed
      inboxReadUntil = persisted.readUntil
      inboxService.invalidate()
    }
    return { ok: Boolean(id), dismissed: inboxDismissed ?? [] }
  }))
  handle('yan:taskinbox:seen', (sessionId: string) => updateInbox(async () => {
    const id = String(sessionId ?? '')
    if (!id) return { ok: false }
    const candidate = { ...inboxReadUntil, [id]: Date.now() }
    const persisted = await writeInboxState({ dismissed: inboxDismissed ?? [], readUntil: candidate })
    inboxDismissed = persisted.dismissed
    inboxReadUntil = persisted.readUntil
    inboxService.invalidate()
    return { ok: true }
  }))
}
