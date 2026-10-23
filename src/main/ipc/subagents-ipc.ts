import type { IpcRegistrar } from './registrar'
import type { ExpectedRuntimeOwner } from '../../shared/ipc'
import type { SubagentService } from '../subagent-service'
import { normalizeSubagentId } from '../../shared/subagent-id'

const INVALID_ID = { ok: false, error: '子代理 id 不合法' }

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
      return { ok: false, error: error instanceof Error ? error.message : '子代理服务暂不可用' }
    }
    const settled = await contextResult
    if (!settled.ok) {
      return { ok: false, error: settled.error instanceof Error ? settled.error.message : '子代理父会话已不可用，未派发' }
    }
    ctrl.setContext(settled.value)
    const mode = isolation === 'controlled-cwd' ? 'controlled-cwd' : isolation === 'worktree' ? 'worktree' : 'shared-cwd'
    return ctrl.start(String(task ?? ''), typeof model === 'string' ? model : undefined, mode)
  })
  handle('yan:subagents:stop', async (id: string) => {
    const runId = normalizeSubagentId(id)
    if (!runId) return INVALID_ID
    return (await service.get()).stop(runId)
  })
  handle('yan:subagents:send', async (id: string, message: string) => {
    const runId = normalizeSubagentId(id)
    if (!runId) return INVALID_ID
    const text = String(message ?? '')
    if (text.length > 12_000) return { ok: false, error: '信息不能超过 12000 个字符' }
    const result = await (await service.get()).send(runId, text, 'steer', { from: 'user' })
    return { ok: result.ok, ...(result.error ? { error: result.error } : {}), ...(result.delivery ? { delivery: result.delivery } : {}) }
  })
  handle('yan:subagents:dismiss', async (id: string) => {
    const runId = normalizeSubagentId(id)
    if (!runId) return INVALID_ID
    return (await service.get()).dismiss(runId)
  })
  handle('yan:subagents:stopAll', async () => {
    await (await service.get()).stopAll()
  })
  handle('yan:subagents:clear', async () => {
    await (await service.get()).clearFinished()
  })
  handle('yan:subagents:merge', async (id: string) => {
    const runId = normalizeSubagentId(id)
    if (!runId) return INVALID_ID
    return (await service.get()).merge(runId)
  })
  handle('yan:subagents:discard', async (id: string) => {
    const runId = normalizeSubagentId(id)
    if (!runId) return INVALID_ID
    return (await service.get()).discard(runId)
  })
}
