import type { IpcRegistrar } from './registrar'
import type { ExpectedRuntimeOwner } from '../../shared/ipc'
import type { SubagentService } from '../subagent-service'
import { normalizeSubagentId } from '../../shared/subagent-id'
import { pick } from '../../shared/ui-lang'

const invalidId = () => ({ ok: false, error: pick('子 Agent id 不合法', 'Invalid subagent id') })

export interface SubagentParentContext {
  cwd: string
  parentSessionId?: string
  parentRunId?: string
  parentGeneration?: number
  projectId?: string
}

export interface SubagentsIpcDeps {
  service: SubagentService
  parentContext(owner?: ExpectedRuntimeOwner): Promise<SubagentParentContext>
  latestMessageId?(parentRunId: string): string | undefined
}

export function registerSubagentsIpc(ipc: IpcRegistrar, deps: SubagentsIpcDeps): void {
  const { handle } = ipc
  const { service, parentContext } = deps
  handle('yan:subagents:list', async () => (await service.get()).list())
  handle('yan:subagents:get', async (id: unknown) => (typeof id === 'string' ? (await (await service.get()).getFull(id)) ?? null : null))
  handle('yan:subagents:start', async (task: string, model?: string, isolation?: string, expectedRuntime?: unknown) => {
    const contextResult = parentContext(expectedRuntime as ExpectedRuntimeOwner | undefined).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    )
    let ctrl: Awaited<ReturnType<SubagentService['get']>>
    try {
      ctrl = await service.get()
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : pick('子 Agent服务暂不可用', 'Subagent service unavailable') }
    }
    const settled = await contextResult
    if (!settled.ok) {
      return { ok: false, error: settled.error instanceof Error ? settled.error.message : pick('子 Agent父会话已不可用，未派发', 'Parent session of the subagent is unavailable; not dispatched') }
    }
    ctrl.setContext(settled.value)
    const mode = isolation === 'controlled-cwd' ? 'controlled-cwd' : isolation === 'worktree' ? 'worktree' : 'shared-cwd'
    return ctrl.start(String(task ?? ''), typeof model === 'string' ? model : undefined, mode)
  })
  handle('yan:subagents:askSideQuestion', async (question: unknown, expectedRuntime?: unknown) => {
    let context: SubagentParentContext
    try {
      context = await parentContext(expectedRuntime as ExpectedRuntimeOwner | undefined)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : pick('当前会话已不可用', 'The current session is unavailable') }
    }
    if (!context.parentRunId) return { ok: false, error: pick('当前会话还没有启动，不能旁路快问', 'The session has not started; side questions need one') }
    const parentMessageId = deps.latestMessageId?.(context.parentRunId)
    return service.askSideQuestion(String(question ?? ''), { ...context, ...(parentMessageId ? { parentMessageId } : {}) })
  })
  handle('yan:subagents:stop', async (id: string) => {
    const runId = normalizeSubagentId(id)
    if (!runId) return invalidId()
    return (await service.get()).stop(runId)
  })
  handle('yan:subagents:send', async (id: string, message: string) => {
    const runId = normalizeSubagentId(id)
    if (!runId) return invalidId()
    const text = String(message ?? '')
    if (text.length > 12_000) return { ok: false, error: pick('信息不能超过 12000 个字符', 'Message cannot exceed 12000 characters') }
    const result = await (await service.get()).send(runId, text, 'steer', { from: 'user' })
    return { ok: result.ok, ...(result.error ? { error: result.error } : {}), ...(result.delivery ? { delivery: result.delivery } : {}) }
  })
  handle('yan:subagents:dismiss', async (id: string) => {
    const runId = normalizeSubagentId(id)
    if (!runId) return invalidId()
    return (await service.get()).dismiss(runId)
  })
  handle('yan:subagents:stopAll', async () => {
    await (await service.get()).stopAll()
  })
  handle('yan:subagents:clear', async (ids: unknown) => {
    const runIds = Array.isArray(ids) ? ids.map(normalizeSubagentId).filter((id): id is string => !!id) : undefined
    await (await service.get()).clearFinished(runIds)
  })
  handle('yan:subagents:merge', async (id: string) => {
    const runId = normalizeSubagentId(id)
    if (!runId) return invalidId()
    return (await service.get()).merge(runId)
  })
  handle('yan:subagents:discard', async (id: string) => {
    const runId = normalizeSubagentId(id)
    if (!runId) return invalidId()
    return (await service.get()).discard(runId)
  })
}
