/**
 * MCP App 视图桥的 IPC 适配（`yan:mcpAppView:*`）。
 *
 * 渲染端只经 preload 白名单调用这里；主进程把调用原样交给 `McpAppViewService`，
 * 不做任何身份 / 授权判定（那些在 service 里，且只从实际 runnner 事实派生）。
 * service 由宿主惰性注入：主进程初始化晚于 registerIpc 时，未就绪的调用一律
 * 返回明确「未就绪」，绝不静默成功。
 *
 * 本文件不 import Electron，只依赖注入的 registrar 与 service 读取器，便于单测。
 */
import type { IpcRegistrar } from './registrar'
import { MCP_APP_VIEW_CHANNELS } from '../../shared/mcp-app-view'
import type {
  McpAppViewApi,
  McpAppViewDescriptor,
  McpAppViewRefreshResult,
  McpAppViewSnapshot
} from '../../shared/mcp-app-view'

export interface McpAppViewIpcDeps {
  /** 当前可用的视图桥；未初始化时返回 null（调用方如实报未就绪）。 */
  service(): McpAppViewApi | null
}

function notReadyDescriptor(): McpAppViewDescriptor {
  return { kind: 'error', error: 'MCP App 宿主尚未就绪' }
}

function rpcNotReady(): unknown {
  return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'MCP App 宿主尚未就绪' } }
}

export function registerMcpAppViewIpc(ipc: IpcRegistrar, deps: McpAppViewIpcDeps): void {
  const { handle } = ipc
  const service = (): McpAppViewApi | null => {
    try {
      return deps.service()
    } catch {
      return null
    }
  }

  handle(MCP_APP_VIEW_CHANNELS.prepare, async (callId: unknown): Promise<McpAppViewDescriptor> => {
    const api = service()
    if (!api) return notReadyDescriptor()
    return api.prepare(typeof callId === 'string' ? callId : '')
  })

  handle(MCP_APP_VIEW_CHANNELS.dispatch, async (instanceId: unknown, message: unknown): Promise<unknown> => {
    const api = service()
    if (!api) return rpcNotReady()
    return api.dispatch(typeof instanceId === 'string' ? instanceId : '', message)
  })

  handle(MCP_APP_VIEW_CHANNELS.release, async (instanceId: unknown): Promise<{ ok: boolean }> => {
    const api = service()
    if (api) await api.release(typeof instanceId === 'string' ? instanceId : '')
    return { ok: true }
  })

  handle(MCP_APP_VIEW_CHANNELS.audit, async (callId: unknown) => {
    const api = service()
    if (!api) return []
    return api.audit(typeof callId === 'string' ? callId : '')
  })

  handle(MCP_APP_VIEW_CHANNELS.snapshot, async (): Promise<McpAppViewSnapshot> => {
    const api = service()
    if (!api) return { needsRefresh: true, toolCount: 0 }
    return api.snapshot()
  })

  handle(MCP_APP_VIEW_CHANNELS.refresh, async (): Promise<McpAppViewRefreshResult> => {
    const api = service()
    if (!api) return { ok: false, toolCount: 0, error: 'MCP App 宿主尚未就绪' }
    return api.refresh()
  })

  /*
   * 已打开实例的可信宿主上下文（与 `ui/initialize` 同源）。渲染端只传 instanceId；
   * 实例归属 / 运行代次由 service 守卫。拿不到就返回 null，渲染端不会因此推通知。
   */
  handle(MCP_APP_VIEW_CHANNELS.hostContext, async (instanceId: unknown): Promise<unknown | null> => {
    const api = service()
    if (!api) return null
    return api.hostContext(typeof instanceId === 'string' ? instanceId : '')
  })
}
