import type { IpcRegistrar } from './registrar'
import type { ExpectedRuntimeOwner } from '../../shared/ipc'
import type { SubagentService } from '../subagent-service'

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
  handle('yan:subagents:stop', async (id: string) => (await service.get()).stop(String(id ?? '')))
  handle('yan:subagents:dismiss', async (id: string) => (await service.get()).dismiss(String(id ?? '')))
  handle('yan:subagents:stopAll', async () => {
    await (await service.get()).stopAll()
  })
  handle('yan:subagents:clear', async () => {
    await (await service.get()).clearFinished()
  })
  handle('yan:subagents:merge', async (id: string) => (await service.get()).merge(String(id ?? '')))
  handle('yan:subagents:discard', async (id: string) => (await service.get()).discard(String(id ?? '')))
}
