import type { IpcRegistrar } from './registrar'
import { MCP_APP_VIEW_CHANNELS } from '../../shared/mcp-app-view'
import type {
  McpAppViewApi,
  McpAppViewDescriptor,
  McpAppViewRefreshResult,
  McpAppViewSnapshot
} from '../../shared/mcp-app-view'

export interface McpAppViewIpcDeps {
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

  handle(MCP_APP_VIEW_CHANNELS.hostContext, async (instanceId: unknown): Promise<unknown | null> => {
    const api = service()
    if (!api) return null
    return api.hostContext(typeof instanceId === 'string' ? instanceId : '')
  })
}
