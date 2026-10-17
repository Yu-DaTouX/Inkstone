import type { McpServerStatus } from '../../shared/mcp'
import type { McpConnectionManager } from './connection-manager'
import { loadMcpServers, type McpConfigLoadResult } from './config'
import { isInkstoneManaged, type McpAppServerConfig } from './app-spec'
import { mcpAppHost, type McpAppHost, type McpAppToolDescriptor } from './app-host'

export interface SettingsSafeAccess {
  loadServers(): McpConfigLoadResult
  legacyManagers(): readonly McpConnectionManager[]
  host(): McpAppHost
}

export class SettingsSafeAccessError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'SettingsSafeAccessError'
  }
}

function visibleServers(access: SettingsSafeAccess, projectId: string | undefined): McpAppServerConfig[] {
  const { servers } = access.loadServers()
  return servers.filter(
    (server) => !server.projectScope || (Boolean(projectId) && server.projectScope === projectId)
  )
}

export function managedConfigOf(
  access: SettingsSafeAccess,
  serverId: string,
  projectId?: string
): McpAppServerConfig | null {
  const config = visibleServers(access, projectId).find((server) => server.id === serverId)
  return config && isInkstoneManaged(config) ? config : null
}

export function managedConfigById(
  access: SettingsSafeAccess,
  serverId: string
): McpAppServerConfig | null {
  const config = access.loadServers().servers.find((server) => server.id === serverId)
  return config && isInkstoneManaged(config) ? config : null
}

export interface LegacyReconcileResult {
  managed: boolean
  config: McpAppServerConfig | null
  legacyHeld: boolean
  legacyReleased: boolean
}

export async function reconcileLegacyManaged(
  access: SettingsSafeAccess,
  serverId: string,
  projectId?: string
): Promise<LegacyReconcileResult> {
  const config = managedConfigOf(access, serverId, projectId)
  if (!config) return { managed: false, config: null, legacyHeld: false, legacyReleased: false }
  let legacyHeld = false
  let legacyReleased = false
  for (const manager of access.legacyManagers()) {
    if (!manager.listServerIds().includes(serverId)) continue
    legacyHeld = true
    const released = await manager.disconnect(serverId)
    if (!released) {
      throw new SettingsSafeAccessError(
        'legacy-holder-unresolved',
        `旧 MCP 连接管理器仍登记着 ${serverId}，但无法断开；不交给砚宿主，避免双连接`
      )
    }
    legacyReleased = true
  }
  return { managed: true, config, legacyHeld, legacyReleased }
}

export interface ManagedRuntimeFacts {
  status: McpServerStatus
  toolCount: number | null
}

export function managedRuntimeFacts(access: SettingsSafeAccess, serverId: string): ManagedRuntimeFacts {
  const host = access.host()
  return { status: host.statusOf(serverId).status, toolCount: host.toolCountOf(serverId) }
}

export interface ManagedVerifyResult {
  status: McpServerStatus
  toolCount: number
}

export async function verifyManagedServer(
  access: SettingsSafeAccess,
  serverId: string,
  callerProjectId: string | undefined
): Promise<ManagedVerifyResult> {
  const config = managedConfigOf(access, serverId, callerProjectId)
  if (!config) {
    throw new SettingsSafeAccessError('not-managed', `服务 ${serverId} 当前不由砚托管，不能走托管检查路径`)
  }
  await reconcileLegacyManaged(access, serverId, callerProjectId)
  const host = access.host()
  await host.reconcile(serverId)
  const tools = await host.listToolsWithMeta(serverId, callerProjectId ? { projectId: callerProjectId } : {})
  return { status: host.statusOf(serverId).status, toolCount: tools.length }
}

export async function disconnectManagedServer(
  access: SettingsSafeAccess,
  serverId: string,
  projectId?: string
): Promise<boolean> {
  await reconcileLegacyManaged(access, serverId, projectId)
  return access.host().disconnect(serverId)
}

export async function probeManagedServer(
  access: SettingsSafeAccess,
  serverId: string,
  callerProjectId: string | undefined
): Promise<{ tools: string[] }> {
  const config = managedConfigById(access, serverId)
  if (!config) {
    throw new SettingsSafeAccessError('not-managed', `服务 ${serverId} 当前不由砚托管，不能走托管 probe 路径`)
  }
  if (!callerProjectId || !callerProjectId.trim()) {
    throw new SettingsSafeAccessError(
      'managed-project-required',
      `服务 ${serverId} 由砚托管，但没有调用者项目身份，拒绝用服务声明的项目代替调用者`
    )
  }
  await reconcileLegacyManaged(access, serverId, callerProjectId)
  const host = access.host()
  await host.reconcile(serverId)
  const tools: McpAppToolDescriptor[] = await host.listToolsWithMeta(serverId, { projectId: callerProjectId })
  return { tools: tools.map((tool) => tool.name) }
}

export function createDefaultSettingsSafeAccess(): SettingsSafeAccess {
  return {
    loadServers: () => loadMcpServers(),
    legacyManagers: () => [],
    host: () => mcpAppHost()
  }
}
