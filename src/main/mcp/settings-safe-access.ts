/**
 * 设置页 MCP **检查 / 状态 / 断开 / 登记 probe** 的单一连接归属路径。
 *
 * ── 它解决什么 ──
 *   一个服务只归一方连接：pi 原生（走 `McpConnectionManager`）或砚托管
 *   （走进程级 `McpAppHost` 单例）。设置页的旧实现只看启动时构造的 legacy
 *   manager 快照：
 *     · 「检查」直接 `manager.listToolsCached()` —— 托管服务会被点出**第二条**连接；
 *     · 「状态」读内存快照，不反映「配置后来转托管」；
 *     · 「断开」只断 legacy manager，托管连接不动（或反过来整池 close）。
 *
 *   本模块把「读**最新**配置判归属」集中到一处，并规定：
 *     · 托管项一律不新建 legacy 连接；状态从 `McpAppHost` 只读缓存取（不连接）；
 *     · 显式用户检查 / probe 先 `reconcile`，再用同一 host 的
 *       `listToolsWithMeta`；调用者项目身份必须由调用方提供，不从
 *       `config.projectScope` 伪造；
 *     · 归属刚从 pi 转为砚时，旧 legacy manager 里可能仍有活连接：**对账时
 *       await 断开该 server**，随后才允许交给 host；断 A 不关 B。
 *
 * 依赖以 `SettingsSafeAccess` 注入，既让生产接线显式，又能在 Node 里用 fake
 * manager / fake host 观测「有没有走旧连接」。本模块不读取任何凭证，也不写盘。
 */
import type { McpServerStatus } from '../../shared/mcp'
import type { McpConnectionManager } from './connection-manager'
import { loadMcpServers, type McpConfigLoadResult } from './config'
import { isInkstoneManaged, type McpAppServerConfig } from './app-spec'
import { mcpAppHost, type McpAppHost, type McpAppToolDescriptor } from './app-host'

/** 生产接线注入点；测试用 fake 实现观测连接路径。 */
export interface SettingsSafeAccess {
  /** 读最新砚配置（不是过期 manager 快照）。 */
  loadServers(): McpConfigLoadResult
  /**
   * 只读现有 legacy manager（**不得创建**）。
   * 含现役 manager 与「因配置转托管而退役、等待显式对账」的旧 manager。
   */
  legacyManagers(): readonly McpConnectionManager[]
  /** 进程级宿主单例（`McpAppHost`）。 */
  host(): McpAppHost
}

/** 单一归属路径的显式失败；`code` 供上层与测试断言。 */
export class SettingsSafeAccessError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'SettingsSafeAccessError'
  }
}

/** 项目可见性过滤（与 `mcpServersForProject` 同口径，但保留 App 归属字段类型）。 */
function visibleServers(access: SettingsSafeAccess, projectId: string | undefined): McpAppServerConfig[] {
  const { servers } = access.loadServers()
  return servers.filter(
    (server) => !server.projectScope || (Boolean(projectId) && server.projectScope === projectId)
  )
}

/** 当前实例可见且此刻归砚托管的配置；非托管 / 不可见返回 null。 */
export function managedConfigOf(
  access: SettingsSafeAccess,
  serverId: string,
  projectId?: string
): McpAppServerConfig | null {
  const config = visibleServers(access, projectId).find((server) => server.id === serverId)
  return config && isInkstoneManaged(config) ? config : null
}

/**
 * 按 id 判托管，**不看项目可见性**：登记 probe 先用它拦住「这个 id 归砚托管」，
 * 免得跨项目 caller 落到 legacy 分支连走第二条连接。项目授权由宿主守卫判定。
 */
export function managedConfigById(
  access: SettingsSafeAccess,
  serverId: string
): McpAppServerConfig | null {
  const config = access.loadServers().servers.find((server) => server.id === serverId)
  return config && isInkstoneManaged(config) ? config : null
}

/** 归属判定（读最新配置，不创建连接）。 */
export function isManagedServer(
  access: SettingsSafeAccess,
  serverId: string,
  projectId?: string
): boolean {
  return managedConfigOf(access, serverId, projectId) !== null
}

export interface LegacyReconcileResult {
  managed: boolean
  config: McpAppServerConfig | null
  /** 旧 legacy manager 里曾登记该服务（无论当时是否还连着）。 */
  legacyHeld: boolean
  /** 本次是否真的 await 断开了旧 legacy 的该连接。 */
  legacyReleased: boolean
}

/**
 * 动态对账：配置刚转托管的服务，若旧 legacy manager 里仍有它，**await 断开该
 * server**（只断这一条，不 `close()` 整个 manager）。不创建 manager、不建连接。
 */
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

/** 托管服务的只读状态：读宿主已持有的连接缓存，**不新建连接**。 */
export function managedRuntimeFacts(access: SettingsSafeAccess, serverId: string): ManagedRuntimeFacts {
  const host = access.host()
  return { status: host.statusOf(serverId).status, toolCount: host.toolCountOf(serverId) }
}

/**
 * 设置页显式「检查」：先对账旧 legacy 残留，再在**同一 host 单例**上
 * `reconcile` + `listToolsWithMeta`。调用者项目身份由调用方给出（真实
 * runner 的 `capabilityProjectId`），不从 `config.projectScope` 伪造。
 */
/** 显式检查结果：工具数来自本次真实列工具，不是缓存，因此是非空 number。 */
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

/** 托管服务的显式断开：只断该 server 的宿主连接，不 `close()` 整个连接池。 */
export async function disconnectManagedServer(
  access: SettingsSafeAccess,
  serverId: string,
  projectId?: string
): Promise<boolean> {
  await reconcileLegacyManaged(access, serverId, projectId)
  return access.host().disconnect(serverId)
}

/**
 * 登记 probe 的托管分支：只走宿主单例，且**必须有调用者项目身份**。
 * 没有项目事实就明确拒绝 —— 不从 `config.projectScope` 反推 caller。
 */
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

/** 生产默认实现：最新配置 + 进程级宿主单例；无 legacy manager（登记入口不持有它）。 */
export function createDefaultSettingsSafeAccess(): SettingsSafeAccess {
  return {
    loadServers: () => loadMcpServers(),
    legacyManagers: () => [],
    host: () => mcpAppHost()
  }
}
