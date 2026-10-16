/**
 * 子代理面板的 IPC 适配（`yan:subagents:*`）。
 * 与模型的 `yan subagent …` 共用 SubagentService 里的同一个控制器；
 * merge / discard 只在这里提供 —— worktree 结果由用户在详情面板审阅。
 */
import type { IpcRegistrar } from './registrar'
import type { ExpectedRuntimeOwner } from '../../shared/ipc'
import type { SubagentService } from '../subagent-service'

export interface SubagentParentContext {
  cwd: string
  parentSessionId?: string
  parentRunId?: string
  /** 父运行实例的代次；同代 pending → 真实 SID 迁移的证明，0 也有效。 */
  parentGeneration?: number
  projectId?: string
}

export interface SubagentsIpcDeps {
  service: SubagentService
  /**
   * 从界面启动时的父会话。给了 `owner` 就按它**严格定位**已有运行实例，
   * 定位不到必须抛出（不退回当前 `active`）；不传时保持原「入口同步钉住当前父」语义。
   */
  parentContext(owner?: ExpectedRuntimeOwner): Promise<SubagentParentContext>
}

export function registerSubagentsIpc(ipc: IpcRegistrar, deps: SubagentsIpcDeps): void {
  const { handle } = ipc
  const { service, parentContext } = deps
  handle('yan:subagents:list', async () => (await service.get()).list())
  handle('yan:subagents:start', async (task: string, model?: string, isolation?: string, expectedRuntime?: unknown) => {
    /*
     * 父上下文必须在 `service.get()` **之前**开始捕获：`parentContext` 的 async
     * 函数体在第一个 `await` 之前会同步快照父实例身份（见 main/index.ts 的
     * `captureDefaultParent`）。这里先把 promise 挂上，再等控制器——两个 await
     * 的等待期（建控制器、读设置）都不会让父归属漂移。
     */
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
    /*
     * `owner` 是渲染端在**显示视图**上找到的已有运行实例，后台查看 B 时不会落到
     * active A；显式 `null` / 非法形状一律由 `parentContext` 判为不可用。解析失败
     * 在 `start` 之前返回，不占用并发槽、不新建任何进程。
     */
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
