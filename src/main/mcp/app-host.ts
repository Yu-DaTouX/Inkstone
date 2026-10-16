import { McpConnectionManager, type McpRawToolDescriptor, type McpRequestOptions } from './connection-manager'
import { loadMcpServers } from './config'
import { toolResultText, type McpServerStatus } from '../../shared/mcp'
import {
  isInkstoneManaged,
  isMcpAppMimeType,
  mcpAppClientCapabilities,
  mcpAppCspOf,
  mcpAppResourceUriOf,
  mcpAppVisibilityOf,
  MCP_APP_MIME_TYPE,
  MCP_APP_RESOURCE_MAX_BYTES,
  type McpAppCsp,
  type McpAppServerConfig,
  type McpAppVisibility
} from './app-spec'
import {
  McpAppOwnershipError,
  McpAppOwnershipGuard,
  type McpAppOwnershipDecision,
  type McpAppOwnershipFactsSource
} from './app-ownership-guard'

export { McpAppOwnershipError, McpAppOwnershipGuard } from './app-ownership-guard'

export class McpAppUnmanagedError extends Error {
  readonly code = 'not-managed'
  constructor(message: string) {
    super(message)
    this.name = 'McpAppUnmanagedError'
  }
}

export class McpAppResourceError extends Error {
  readonly code = 'resource-invalid'
  constructor(message: string) {
    super(message)
    this.name = 'McpAppResourceError'
  }
}

export class McpAppResourceTooLargeError extends Error {
  readonly code = 'resource-too-large'
  constructor(
    readonly uri: string,
    readonly bytes: number,
    readonly limit: number
  ) {
    super(`资源 ${uri} 有 ${bytes} 字节，超过上限 ${limit} 字节`)
    this.name = 'McpAppResourceTooLargeError'
  }
}

export interface McpAppToolDescriptor {
  name: string
  description?: string
  inputSchema?: unknown
  annotations?: unknown
  meta?: Record<string, unknown>
  visibility: McpAppVisibility[]
  modelVisible: boolean
  appVisible: boolean
  resourceUri: string | null
}

export interface McpAppCallOutcome {
  result: unknown
  meta: Record<string, unknown> | null
  structuredContent: Record<string, unknown> | null
  resourceUri: string | null
  uiCsp: McpAppCsp | null
  isError: boolean
  text: string
}

export interface McpAppResource {
  uri: string
  mimeType: string
  text: string
  bytes: number
  meta: Record<string, unknown> | null
  uiCsp: McpAppCsp | null
}

export interface McpAppRequestOptions extends McpRequestOptions {
  projectId?: string
}

export interface McpAppReconcileResult {
  serverId: string
  managed: boolean
  eligible: boolean
  closed: boolean
  code?: string
  message?: string
}

export interface McpAppHostOptions {
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  maxResourceBytes?: number
  ownership?: McpAppOwnershipGuard | McpAppOwnershipFactsSource
  createManager?: (config: McpAppServerConfig, timeoutMs: number) => McpConnectionManager
}

interface PooledServer {
  fingerprint: string
  manager: McpConnectionManager
}

type OwnershipEvaluation =
  | { ok: true; config: McpAppServerConfig; fingerprint: string }
  | { ok: false; error: McpAppUnmanagedError | McpAppOwnershipError }

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function configFingerprint(config: McpAppServerConfig): string {
  return JSON.stringify({
    id: config.id,
    transport: config.transport,
    command: config.command ?? null,
    args: config.args ?? null,
    env: config.env ?? null,
    url: config.url ?? null,
    enabled: config.enabled ?? true,
    ownedBy: config.ownedBy ?? null,
    projectScope: config.projectScope ?? null
  })
}

function toAppToolDescriptor(tool: McpRawToolDescriptor): McpAppToolDescriptor {
  const visibility = mcpAppVisibilityOf(tool.meta)
  return {
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
    ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
    ...(tool.meta !== undefined ? { meta: tool.meta } : {}),
    visibility,
    modelVisible: visibility.includes('model'),
    appVisible: visibility.includes('app'),
    resourceUri: mcpAppResourceUriOf(tool.meta)
  }
}

function toCallOutcome(raw: unknown): McpAppCallOutcome {
  const record = asRecord(raw)
  const meta = asRecord(record?._meta)
  return {
    result: raw,
    meta,
    structuredContent: asRecord(record?.structuredContent),
    resourceUri: mcpAppResourceUriOf(meta),
    uiCsp: mcpAppCspOf(meta),
    isError: Boolean(record?.isError),
    text: toolResultText(raw)
  }
}

function toGuard(ownership: McpAppHostOptions['ownership']): McpAppOwnershipGuard {
  if (ownership instanceof McpAppOwnershipGuard) return ownership
  return new McpAppOwnershipGuard(ownership ?? {})
}

export class McpAppHost {
  private readonly env: NodeJS.ProcessEnv
  private readonly timeoutMs: number
  private readonly maxResourceBytes: number
  private readonly createManager: (config: McpAppServerConfig, timeoutMs: number) => McpConnectionManager
  private readonly pool = new Map<string, PooledServer>()
  private readonly poolTails = new Map<string, Promise<unknown>>()
  private ownership: McpAppOwnershipGuard

  constructor(options: McpAppHostOptions = {}) {
    this.env = options.env ?? process.env
    this.timeoutMs = options.timeoutMs ?? 60_000
    this.maxResourceBytes = options.maxResourceBytes ?? MCP_APP_RESOURCE_MAX_BYTES
    this.ownership = toGuard(options.ownership)
    this.createManager =
      options.createManager ??
      ((config, timeoutMs) => new McpConnectionManager([config], timeoutMs, mcpAppClientCapabilities()))
  }

  setOwnership(ownership: McpAppOwnershipGuard | McpAppOwnershipFactsSource): void {
    this.ownership = toGuard(ownership)
  }

  listManagedServers(): McpAppServerConfig[] {
    return loadMcpServers(this.env).servers.filter(isInkstoneManaged)
  }

  statusOf(serverId: string): { status: McpServerStatus; error?: string } {
    const pooled = this.pool.get(serverId)
    if (!pooled) return { status: 'disconnected' }
    return pooled.manager.statusOf(serverId)
  }

  toolCountOf(serverId: string): number | null {
    const pooled = this.pool.get(serverId)
    if (!pooled) return null
    return pooled.manager.toolCountOf(serverId)
  }

  private async checkOwnership(
    serverId: string,
    config: McpAppServerConfig,
    projectId?: string
  ): Promise<McpAppOwnershipDecision> {
    try {
      return await this.ownership.check({ serverId, config, ...(projectId ? { callerProjectId: projectId } : {}) })
    } catch (error) {
      return {
        ok: false,
        code: 'runtime-unknown',
        message: `归属守卫读取事实失败，拒绝连接服务 ${serverId}：${messageOf(error)}`
      }
    }
  }

  private async evaluateOwnership(serverId: string, options: McpAppRequestOptions): Promise<OwnershipEvaluation> {
    const config = loadMcpServers(this.env).servers.find((server) => server.id === serverId)
    if (!config) {
      return { ok: false, error: new McpAppUnmanagedError(`MCP 服务 ${serverId} 不在配置里，拒绝由砚宿主连接`) }
    }
    if (!isInkstoneManaged(config)) {
      return {
        ok: false,
        error: new McpAppUnmanagedError(
          `MCP 服务 ${serverId} 未声明由砚托管（ownedBy=${config.ownedBy ?? 'pi'}），拒绝连接`
        )
      }
    }
    const decision = await this.checkOwnership(serverId, config, options.projectId)
    if (!decision.ok) return { ok: false, error: new McpAppOwnershipError(decision.code, decision.message) }
    return { ok: true, config, fingerprint: configFingerprint(config) }
  }

  private runPool<T>(serverId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.poolTails.get(serverId) ?? Promise.resolve()
    const next = previous.then(work, work)
    this.poolTails.set(
      serverId,
      next.then(
        () => undefined,
        () => undefined
      )
    )
    return next
  }

  private async dropPooled(serverId: string): Promise<boolean> {
    const existing = this.pool.get(serverId)
    if (!existing) return false
    this.pool.delete(serverId)
    await existing.manager.close().catch(() => undefined)
    return true
  }

  private acquire(serverId: string, config: McpAppServerConfig, fingerprint: string): Promise<PooledServer> {
    return this.runPool(serverId, async () => {
      const existing = this.pool.get(serverId)
      if (existing && existing.fingerprint === fingerprint) return existing
      if (existing) {
        this.pool.delete(serverId)
        await existing.manager.close().catch(() => undefined)
      }
      const pooled: PooledServer = { fingerprint, manager: this.createManager(config, this.timeoutMs) }
      this.pool.set(serverId, pooled)
      return pooled
    })
  }

  private async acquireEligible(serverId: string, options: McpAppRequestOptions): Promise<PooledServer> {
    const evaluation = await this.evaluateOwnership(serverId, options)
    if (!evaluation.ok) {
      await this.runPool(serverId, () => this.dropPooled(serverId))
      throw evaluation.error
    }
    return this.acquire(serverId, evaluation.config, evaluation.fingerprint)
  }

  private async assertStillOwned(
    serverId: string,
    pooled: PooledServer,
    options: McpAppRequestOptions
  ): Promise<void> {
    if (this.pool.get(serverId) !== pooled) {
      throw new McpAppOwnershipError('ownership-changed', `服务 ${serverId} 的连接在调用期间已被替换，丢弃本次结果`)
    }
    const evaluation = await this.evaluateOwnership(serverId, options)
    if (!evaluation.ok) {
      await this.runPool(serverId, async () => {
        if (this.pool.get(serverId) === pooled) await this.dropPooled(serverId)
      })
      throw new McpAppOwnershipError(
        'ownership-changed',
        `服务 ${serverId} 的归属在调用期间发生变化，已丢弃本次结果：${evaluation.error.message}`
      )
    }
  }

  async listToolsWithMeta(serverId: string, options: McpAppRequestOptions = {}): Promise<McpAppToolDescriptor[]> {
    const pooled = await this.acquireEligible(serverId, options)
    const raw = await pooled.manager.listToolsRaw(serverId, options)
    await this.assertStillOwned(serverId, pooled, options)
    return raw.map(toAppToolDescriptor)
  }

  async callToolWithMeta(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    options: McpAppRequestOptions = {}
  ): Promise<McpAppCallOutcome> {
    const pooled = await this.acquireEligible(serverId, options)
    const raw = await pooled.manager.callTool(serverId, toolName, args, options)
    await this.assertStillOwned(serverId, pooled, options)
    return toCallOutcome(raw)
  }

  async readResource(serverId: string, uri: string, options: McpAppRequestOptions = {}): Promise<McpAppResource> {
    const pooled = await this.acquireEligible(serverId, options)
    const raw = await pooled.manager.readResource(serverId, uri, options)
    await this.assertStillOwned(serverId, pooled, options)
    return this.normalizeResource(uri, raw)
  }

  async reconcile(serverId: string): Promise<McpAppReconcileResult> {
    const config = loadMcpServers(this.env).servers.find((server) => server.id === serverId)
    const managed = Boolean(config && isInkstoneManaged(config))
    if (!config || !managed) {
      const closed = await this.runPool(serverId, () => this.dropPooled(serverId))
      return {
        serverId,
        managed,
        eligible: false,
        closed,
        code: 'not-managed',
        message: config
          ? `MCP 服务 ${serverId} 未声明由砚托管（ownedBy=${config.ownedBy ?? 'pi'}），已断开旧连接`
          : `MCP 服务 ${serverId} 不在配置里，已断开旧连接`
      }
    }
    const decision = await this.checkOwnership(serverId, config)
    if (!decision.ok) {
      const closed = await this.runPool(serverId, () => this.dropPooled(serverId))
      return { serverId, managed: true, eligible: false, closed, code: decision.code, message: decision.message }
    }
    const fingerprint = configFingerprint(config)
    let closed = false
    await this.runPool(serverId, async () => {
      const existing = this.pool.get(serverId)
      if (existing && existing.fingerprint !== fingerprint) {
        await this.dropPooled(serverId)
        closed = true
      }
    })
    return { serverId, managed: true, eligible: true, closed }
  }

  async reconcileAll(): Promise<McpAppReconcileResult[]> {
    const ids = new Set<string>(this.pool.keys())
    for (const server of loadMcpServers(this.env).servers) ids.add(server.id)
    const results: McpAppReconcileResult[] = []
    for (const serverId of ids) results.push(await this.reconcile(serverId))
    return results
  }

  async disconnect(serverId: string): Promise<boolean> {
    return this.runPool(serverId, () => this.dropPooled(serverId))
  }

  private normalizeResource(uri: string, raw: unknown): McpAppResource {
    const record = asRecord(raw)
    const contents = record && Array.isArray(record.contents) ? record.contents : []
    const first = contents.length ? asRecord(contents[0]) : null
    if (!first) throw new McpAppResourceError(`资源 ${uri} 没有内容`)
    const mimeType = typeof first.mimeType === 'string' ? first.mimeType : ''
    if (typeof first.text !== 'string') {
      throw new McpAppResourceError(`资源 ${uri} 不是文本资源（App 页面必须是 ${MCP_APP_MIME_TYPE}）`)
    }
    if (!isMcpAppMimeType(mimeType)) {
      throw new McpAppResourceError(`资源 ${uri} 的 MIME 不是 ${MCP_APP_MIME_TYPE}：${mimeType || '（缺失）'}`)
    }
    const bytes = Buffer.byteLength(first.text, 'utf8')
    if (bytes > this.maxResourceBytes) throw new McpAppResourceTooLargeError(uri, bytes, this.maxResourceBytes)
    const meta = asRecord(first._meta) ?? asRecord(record?._meta)
    const uiCsp = mcpAppCspOf(meta) ?? mcpAppCspOf(record?._meta)
    return { uri, mimeType, text: first.text, bytes, meta, uiCsp }
  }

  async close(): Promise<void> {
    const managers = [...this.pool.values()].map((pooled) => pooled.manager)
    this.pool.clear()
    await Promise.all(managers.map((manager) => manager.close().catch(() => undefined)))
  }
}

let sharedHost: McpAppHost | undefined
let sharedOwnership: McpAppOwnershipGuard | undefined

export function configureMcpAppHostOwnership(ownership: McpAppOwnershipGuard | McpAppOwnershipFactsSource): void {
  const guard = ownership instanceof McpAppOwnershipGuard ? ownership : new McpAppOwnershipGuard(ownership)
  sharedOwnership = guard
  sharedHost?.setOwnership(guard)
}

export function mcpAppHost(): McpAppHost {
  if (!sharedHost) sharedHost = new McpAppHost({ ownership: sharedOwnership ?? {} })
  return sharedHost
}

export async function closeMcpAppHost(): Promise<void> {
  const host = sharedHost
  sharedHost = undefined
  if (host) await host.close()
}
