import { pick } from '../../shared/ui-lang'
import type { McpServerStatus } from '../../shared/mcp'
import type { McpConnectionManager } from './connection-manager'
import { mcpServersForProject, type McpConfigLoadResult } from './config'
import { isInkstoneManaged, type McpAppServerConfig } from './app-spec'
import type { McpAppHost } from './app-host'

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
  return mcpServersForProject(servers, projectId)
}

export function managedConfigOf(
  access: SettingsSafeAccess,
  serverId: string,
  projectId?: string
): McpAppServerConfig | null {
  const config = visibleServers(access, projectId).find((server) => server.id === serverId)
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
        pick(`旧 MCP 连接管理器仍登记着 ${serverId}，但无法断开；不交给砚宿主，避免双连接`, `The legacy MCP connection manager still holds ${serverId} and could not disconnect it; not handed to the Inkstone host to avoid double connections`)
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
    throw new SettingsSafeAccessError('not-managed', pick(`服务 ${serverId} 当前不由砚托管，不能走托管检查路径`, `Service ${serverId} is not managed by Inkstone, so the managed check path is unavailable`))
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
