/**
 * 子代理面板的 IPC 适配（`yan:subagents:*`）。
 * 与模型的 `yan subagent …` 共用 SubagentService 里的同一个控制器；
 * merge / discard 只在这里提供 —— worktree 结果由用户在详情面板审阅。
 */
import type { IpcRegistrar } from './registrar'
import type { SubagentService } from '../subagent-service'

export interface SubagentParentContext {
  cwd: string
  parentSessionId?: string
  parentRunId?: string
  projectId?: string
}

export interface SubagentsIpcDeps {
  service: SubagentService
  /** 从界面启动时的父会话（当前前台会话） */
  parentContext(): Promise<SubagentParentContext>
}

export function registerSubagentsIpc(ipc: IpcRegistrar, deps: SubagentsIpcDeps): void {
  const { handle } = ipc
  const { service, parentContext } = deps
  handle('yan:subagents:list', async () => (await service.get()).list())
  handle('yan:subagents:start', async (task: string, model?: string, isolation?: string) => {
    const ctrl = await service.get()
    ctrl.setContext(await parentContext())
    const mode = isolation === 'controlled-cwd' ? 'controlled-cwd' : isolation === 'worktree' ? 'worktree' : 'shared-cwd'
    return ctrl.start(String(task ?? ''), typeof model === 'string' ? model : undefined, mode)
  })
  handle('yan:subagents:stop', async (id: string) => (await service.get()).stop(String(id ?? '')))
  handle('yan:subagents:stopAll', async () => {
    await (await service.get()).stopAll()
  })
  handle('yan:subagents:clear', async () => {
    ;(await service.get()).clearFinished()
  })
  handle('yan:subagents:merge', async (id: string) => (await service.get()).merge(String(id ?? '')))
  handle('yan:subagents:discard', async (id: string) => (await service.get()).discard(String(id ?? '')))
}
