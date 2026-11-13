import { pick } from '../../shared/ui-lang'
import type { McpServerConfig, McpServerStatus } from '../../shared/mcp'
import type { CapabilityMcpServerSettingView } from '../../shared/ipc'
import { McpConnectionManager, type McpCloseOutcome } from './connection-manager'
import { loadMcpServers, mcpServersForProject, type McpConfigLoadResult } from './config'
import { mcpAppHost, type McpAppHost } from './app-host'
import { isInkstoneManaged } from './app-spec'
import {
  disconnectManagedServer,
  managedRuntimeFacts,
  reconcileLegacyManaged,
  verifyManagedServer,
  SettingsSafeAccessError,
  type LegacyReconcileResult,
  type SettingsSafeAccess
} from './settings-safe-access'

export interface RunnerMcpConnectionsDeps {
  projectId(): string | undefined
  loadServers?(): McpConfigLoadResult
  createManager?(configs: readonly McpServerConfig[]): McpConnectionManager
  host?(): McpAppHost
}

function endpointOriginOf(server: { transport: string; url?: string }): string | undefined {
  if (server.transport !== 'http' || !server.url) return undefined
  try {
    const origin = new URL(server.url).origin
    return origin === 'null' ? undefined : origin
  } catch {
    return undefined
  }
}

export class RunnerMcpConnections {
  private manager?: McpConnectionManager
  private retired: McpConnectionManager[] = []
  private releasing = new Map<string, Promise<McpCloseOutcome>>()
  private retiredCloseTail: Promise<void> = Promise.resolve()
  private lastConfigError?: string

  constructor(private readonly deps: RunnerMcpConnectionsDeps) {}

  configError(): string | undefined {
    return this.lastConfigError
  }

  current(): McpConnectionManager | undefined {
    return this.manager
  }

  connectionManager(): McpConnectionManager {
    const loaded = this.load()
    this.lastConfigError = loaded.error
    const visible = mcpServersForProject(loaded.servers, this.deps.projectId())
    const legacyConfigs = visible.filter((server) => !isInkstoneManaged(server))
    if (!this.manager) {
      this.manager = this.deps.createManager ? this.deps.createManager(legacyConfigs) : new McpConnectionManager(legacyConfigs)
      return this.manager
    }
    const releases = this.manager.syncServers(legacyConfigs)
    for (const { serverId, release } of releases) {
      this.releasing.set(serverId, release)
      void release.then(
        (outcome) => {
          if (outcome.confirmed && this.releasing.get(serverId) === release) this.releasing.delete(serverId)
        },
        () => {
        }
      )
    }
    return this.manager
  }

  holderSnapshot(): { services: Array<{ serverId: string; status: McpServerStatus }> } {
    const services: Array<{ serverId: string; status: McpServerStatus }> = []
    for (const manager of this.legacyManagers()) {
      for (const serverId of manager.listServerIds()) {
        if (services.some((service) => service.serverId === serverId)) continue
        services.push({ serverId, status: manager.statusOf(serverId).status })
      }
    }
    for (const serverId of this.releasing.keys()) {
      if (services.some((service) => service.serverId === serverId)) continue
      services.push({ serverId, status: 'connecting' })
    }
    return { services }
  }

  async settingsServers(): Promise<CapabilityMcpServerSettingView[]> {
    const loaded = this.load()
    this.lastConfigError = loaded.error
    const visible = mcpServersForProject(loaded.servers, this.deps.projectId())
    const managedConfigs = visible.filter((server) => isInkstoneManaged(server))
    for (const managed of managedConfigs) await this.reconcileForManaged(managed.id)
    const access = this.settingsAccess()
    const manager = this.connectionManager()
    await this.closeRetired()
    const servers: CapabilityMcpServerSettingView[] = []
    for (const server of manager.list()) {
      const endpointOrigin = endpointOriginOf(server)
      servers.push({
        id: server.id,
        title: server.title ?? server.id,
        transport: server.transport,
        enabled: server.enabled !== false,
        effect: server.effect ?? 'unknown',
        projectScoped: Boolean(server.projectScope),
        ...(endpointOrigin ? { endpointOrigin } : {}),
        status: manager.statusOf(server.id).status,
        toolCount: manager.toolCountOf(server.id),
        ownedBy: 'pi'
      })
    }
    for (const config of managedConfigs) {
      const facts = managedRuntimeFacts(access, config.id)
      const endpointOrigin = endpointOriginOf(config)
      servers.push({
        id: config.id,
        title: config.title ?? config.id,
        transport: config.transport,
        enabled: config.enabled !== false,
        effect: config.effect ?? 'unknown',
        projectScoped: Boolean(config.projectScope),
        ...(endpointOrigin ? { endpointOrigin } : {}),
        status: facts.status,
        toolCount: facts.toolCount,
        ownedBy: 'inkstone'
      })
    }
    return servers
  }

  async verify(serverId: string): Promise<{ status: McpServerStatus; toolCount: number }> {
    const access = this.settingsAccess()
    const managed = await this.reconcileForManaged(serverId)
    if (managed.managed) {
      return verifyManagedServer(access, serverId, this.deps.projectId())
    }
    const manager = this.connectionManager()
    await this.closeRetired()
    if (!manager.listServerIds().includes(serverId)) throw new Error(pick('当前 runner 没有这个 MCP 服务', 'This runner has no such MCP server'))
    const tools = await manager.listToolsCached(serverId, { refresh: true })
    return { status: manager.statusOf(serverId).status, toolCount: tools.length }
  }

  async disconnect(serverId: string): Promise<boolean> {
    const access = this.settingsAccess()
    const managed = await this.reconcileForManaged(serverId)
    if (managed.managed) return disconnectManagedServer(access, serverId, this.deps.projectId())
    return this.connectionManager().disconnect(serverId)
  }

  async closeCurrent(): Promise<void> {
    const old = this.manager
    this.manager = undefined
    await old?.close().catch(() => undefined)
  }

  close(): Promise<void> {
    const closing = this.manager
    this.manager = undefined
    return (async (): Promise<void> => {
      await closing?.close().catch(() => undefined)
      await this.closeRetired()
    })()
  }

  closeRetired(): Promise<void> {
    const run = this.retiredCloseTail.then(() => this.closeRetiredNow(), () => this.closeRetiredNow())
    this.retiredCloseTail = run.then(() => undefined, () => undefined)
    return run
  }

  private load(): McpConfigLoadResult {
    return this.deps.loadServers ? this.deps.loadServers() : loadMcpServers()
  }

  private legacyManagers(): McpConnectionManager[] {
    return [this.manager, ...this.retired].filter(
      (manager): manager is McpConnectionManager => Boolean(manager)
    )
  }

  private settingsAccess(): SettingsSafeAccess {
    return {
      loadServers: () => this.load(),
      legacyManagers: () => this.legacyManagers(),
      host: () => (this.deps.host ? this.deps.host() : mcpAppHost())
    }
  }

  private async closeRetiredNow(): Promise<void> {
    if (this.retired.length === 0) return
    const remaining: McpConnectionManager[] = []
    for (const manager of this.retired) {
      const outcome = await manager.closeConfirmed().catch(() => ({ confirmed: false, unknown: 1 }))
      if (!outcome.confirmed) remaining.push(manager)
    }
    this.retired = remaining
  }

  private async reconcileForManaged(serverId: string): Promise<LegacyReconcileResult> {
    const result = await reconcileLegacyManaged(
      this.settingsAccess(),
      serverId,
      this.deps.projectId()
    )
    const releasing = this.releasing.get(serverId)
    if (releasing) {
      const outcome = await releasing
      if (!outcome.confirmed) {
        throw new SettingsSafeAccessError(
          'legacy-holder-unresolved',
          `旧 MCP 连接 ${serverId} 的关闭未能确认，不交给砚宿主，避免双连接`
        )
      }
      if (this.releasing.get(serverId) === releasing) this.releasing.delete(serverId)
      result.legacyReleased = true
    }
    await this.closeRetired()
    return result
  }
}
