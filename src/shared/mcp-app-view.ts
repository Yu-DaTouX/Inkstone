export interface McpAppViewReadyDescriptor {
  kind: 'ready'
  instanceId: string
  url: string
  title: string
  callId: string
}

export interface McpAppViewTextDescriptor {
  kind: 'text'
  text: string
  reason: string
}

export interface McpAppViewErrorDescriptor {
  kind: 'error'
  error: string
}

export type McpAppViewDescriptor =
  | McpAppViewReadyDescriptor
  | McpAppViewTextDescriptor
  | McpAppViewErrorDescriptor

export type McpAppViewAuditPhase = 'requested' | 'denied' | 'approved' | 'completed' | 'error'

export interface McpAppViewAuditEntry {
  id: string
  at: number
  callId: string
  toolName: string
  phase: McpAppViewAuditPhase
  permissionMode: 'all' | 'danger'
  summary: string
  serverId?: string
  instanceId?: string
  argsHash?: string
  reason?: string
}

export interface McpAppViewSnapshot {
  needsRefresh: boolean
  toolCount: number
}

export interface McpAppViewRefreshResult {
  ok: boolean
  toolCount: number
  error?: string
}

export interface McpAppViewApi {
  prepare(callId: string): Promise<McpAppViewDescriptor>
  dispatch(instanceId: string, message: unknown): Promise<unknown>
  release(instanceId: string): Promise<void>
  audit(callId: string): Promise<McpAppViewAuditEntry[]>
  snapshot(): Promise<McpAppViewSnapshot>
  refresh(): Promise<McpAppViewRefreshResult>
  hostContext(instanceId: string): Promise<unknown | null>
}

export const MCP_APP_VIEW_CHANNELS = {
  prepare: 'yan:mcpAppView:prepare',
  dispatch: 'yan:mcpAppView:dispatch',
  release: 'yan:mcpAppView:release',
  audit: 'yan:mcpAppView:audit',
  snapshot: 'yan:mcpAppView:snapshot',
  refresh: 'yan:mcpAppView:refresh',
  hostContext: 'yan:mcpAppView:hostContext'
} as const
