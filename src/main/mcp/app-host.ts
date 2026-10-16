/**
 * MCP Apps 外置宿主的**连接层**。
 *
 * ── 它解决什么 ──
 *   MCP 的普通工具调用只需要「文本结果」，所以现有的 `McpConnectionManager` 会把
 *   结果归一化成 `McpToolDescriptor` / 文本。MCP Apps 不行：渲染一份 `ui://` 页面
 *   必须拿到**原始 `_meta`**（`_meta.ui.resourceUri`、`_meta.ui.csp`）、
 *   `structuredContent` 与资源正文。这一层就是包在连接管理器外面的薄壳，
 *   只做四件事：
 *     1. 归属把关：连接前重读配置并核对**pi 侧事实**（见 `app-ownership-guard.ts`），
 *        只有确实由砚唯一持有且旧 pi 已确认退出的服务才连；
 *     2. 原始形状：`listToolsWithMeta` / `callToolWithMeta` 保留 `_meta` / `structuredContent`；
 *     3. 资源读取：`readResource` 校验 MIME 与体积上限（默认 2 MiB）；
 *     4. 每调用取消：把 `AbortSignal` 透传给 SDK（发 `notifications/cancelled`），
 *        中止/超时后丢弃该连接，沿用底层既有的释放语义。
 *
 * ── 为什么不直接改 connection-manager ──
 *   那条路径被 `agent.ts` / `agent-hub` / CLI 诊断共用，语义（懒连接、并发去重、
 *   硬超时、断线丢客户端、`windows-mcp` 串行）不能变。这里只加了「原始工具列表 /
 *   资源读取 / signal」三个可选入口，其余原样不动。
 *
 * ── 归属守卫缺省 fail-closed ──
 *   没有主进程注入的 `ownership` 事实时，守卫拒绝一切连接（不默认「无旧 runner」）。
 *   生产接线用 `configureMcpAppHostOwnership`；测试显式注入 stub 事实。
 *
 * 缺省一律最严：没写 `inkstone`、缺 `appHost`、被禁用、pi 侧仍有同名条目、旧 runner
 * 未确认退出，都拒绝连接 —— 宁可不渲染，也不静默放宽。
 */
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

/** 配置没把该服务交给砚托管时的明确失败；绝不「先连上再说」。 */
export class McpAppUnmanagedError extends Error {
  readonly code = 'not-managed'
  constructor(message: string) {
    super(message)
    this.name = 'McpAppUnmanagedError'
  }
}

/** 资源形状不对（非文本、缺 MIME、MIME 不是 App 页面）。 */
export class McpAppResourceError extends Error {
  readonly code = 'resource-invalid'
  constructor(message: string) {
    super(message)
    this.name = 'McpAppResourceError'
  }
}

/** 资源超过体积上限：不渲染，交给上层的文本回退。 */
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

/** 工具在 MCP Apps 语境下的投影：原始字段 + 从 `_meta.ui` 推出的可见性。 */
export interface McpAppToolDescriptor {
  name: string
  description?: string
  inputSchema?: unknown
  annotations?: unknown
  meta?: Record<string, unknown>
  /** 缺省按最严：只含 `model`。 */
  visibility: McpAppVisibility[]
  modelVisible: boolean
  appVisible: boolean
  /** 工具自带的 App 页面 URI（若有）；用于快照与界面复核。 */
  resourceUri: string | null
}

/** 一次工具调用的原始结果 + 从 `_meta` 抽出的界面专用字段。 */
export interface McpAppCallOutcome {
  /** 原始结果（含 `_meta` / `structuredContent`）——流水线按原样留证。 */
  result: unknown
  meta: Record<string, unknown> | null
  structuredContent: Record<string, unknown> | null
  /** `_meta.ui.resourceUri`；宿主据此渲染 App 视图。 */
  resourceUri: string | null
  uiCsp: McpAppCsp | null
  isError: boolean
  /** 模型可见的文本（与普通工具结果同口径）。 */
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

/**
 * 请求选项：沿用底层 `signal`，并加**调用者项目身份**。
 * `projectId` 必须由主进程按会话/实例事实注入，渲染端或请求端不能自报；
 * 服务声明了 `projectScope` 时只有同项目调用者能连。
 */
export interface McpAppRequestOptions extends McpRequestOptions {
  projectId?: string
}

/** `reconcile` 的逐服务结果；`closed` 表示本次确实关闭并丢掉了池里的连接。 */
export interface McpAppReconcileResult {
  serverId: string
  /** 配置里当前是否声明为砚托管（`isInkstoneManaged`）。 */
  managed: boolean
  /** 归属守卫是否放行（managed 且 pi 侧无条目、旧 runner 已确认退出）。 */
  eligible: boolean
  /** 本次是否 await 关闭并清掉了缓存连接。 */
  closed: boolean
  code?: string
  message?: string
}

export interface McpAppHostOptions {
  /** 读配置的文件来源（测试指向隔离目录）。 */
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  maxResourceBytes?: number
  /**
   * 归属守卫（主机事实注入）。缺省 fail-closed：不连任何服务。
   * 可传已构造的守卫，或直接传事实对象/动态事实函数。
   */
  ownership?: McpAppOwnershipGuard | McpAppOwnershipFactsSource
  /** 连接管理器工厂；测试注入 fake 以观测真实连接数与关闭次数。缺省建真实连接。 */
  createManager?: (config: McpAppServerConfig, timeoutMs: number) => McpConnectionManager
}

interface PooledServer {
  /** 配置指纹：配置变了就重建连接，不拿旧端点继续用。 */
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

/** 只把决定「连到哪里、执行什么」的字段纳入指纹，`appHost` 的 natives 不参与。 */
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
  /** 每个服务一条串行链：旧连接关闭与新建连接串行，避免出现两条连接。 */
  private readonly poolTails = new Map<string, Promise<unknown>>()
  private ownership: McpAppOwnershipGuard

  constructor(options: McpAppHostOptions = {}) {
    this.env = options.env ?? process.env
    /* 设计默认 60s；底层 legacy `McpConnectionManager` 的默认仍是 20s，不改。 */
    this.timeoutMs = options.timeoutMs ?? 60_000
    this.maxResourceBytes = options.maxResourceBytes ?? MCP_APP_RESOURCE_MAX_BYTES
    this.ownership = toGuard(options.ownership)
    this.createManager =
      options.createManager ??
      ((config, timeoutMs) => new McpConnectionManager([config], timeoutMs, mcpAppClientCapabilities()))
  }

  /** 主进程在拿到新的项目登记 / runner 注册表后可以替换守卫。 */
  setOwnership(ownership: McpAppOwnershipGuard | McpAppOwnershipFactsSource): void {
    this.ownership = toGuard(ownership)
  }

  /** 当前有资格由砚连接的服务；每次重读配置，不信内存快照。 */
  listManagedServers(): McpAppServerConfig[] {
    return loadMcpServers(this.env).servers.filter(isInkstoneManaged)
  }

  /** 某服务此刻的连接状态；从未连接过是 `disconnected`。 */
  statusOf(serverId: string): { status: McpServerStatus; error?: string } {
    const pooled = this.pool.get(serverId)
    if (!pooled) return { status: 'disconnected' }
    return pooled.manager.statusOf(serverId)
  }

  /**
   * 已缓存工具数；从未连接 / 无缓存返回 null。只读缓存，**不触发连接**。
   * 设置页展示托管服务状态时用它，避免为显示计数而握手。
   */
  toolCountOf(serverId: string): number | null {
    const pooled = this.pool.get(serverId)
    if (!pooled) return null
    return pooled.manager.toolCountOf(serverId)
  }

  /**
   * 调守卫；事实来源本身抛错也折算成拒绝（fail-closed），不把异常漏给调用方。
   */
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

  /**
   * 连接前把关：重读配置、核对托管声明、项目身份，再交给归属守卫核对 pi 侧事实。
   * 失败时**先 await 关闭已有池连接并清缓存再抛错** —— 不允许「throw 后旧池还在」。
   */
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

  /** 每服务串行执行池操作：并发调用不会同时重建同一条连接。 */
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

  /** 关闭并清掉该服务的池连接；返回此前是否存在。 */
  private async dropPooled(serverId: string): Promise<boolean> {
    const existing = this.pool.get(serverId)
    if (!existing) return false
    this.pool.delete(serverId)
    await existing.manager.close().catch(() => undefined)
    return true
  }

  /** 在串行链里拿到可用连接；指纹变化时**先 await 关旧再建新**。 */
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

  /** 校验 + 取连接的组合；守卫不通过时先关池再抛。 */
  private async acquireEligible(serverId: string, options: McpAppRequestOptions): Promise<PooledServer> {
    const evaluation = await this.evaluateOwnership(serverId, options)
    if (!evaluation.ok) {
      await this.runPool(serverId, () => this.dropPooled(serverId))
      throw evaluation.error
    }
    return this.acquire(serverId, evaluation.config, evaluation.fingerprint)
  }

  /**
   * 结果发布前二次核对：连接对象没被换掉，且归属此刻仍然合法。
   * 切换 / 删条目 / 禁用发生在调用期间时，丢弃迟到结果并关掉对应池。
   */
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

  /** 带 `_meta` 的工具表（含 `_meta.ui.visibility` / `resourceUri`）。 */
  async listToolsWithMeta(serverId: string, options: McpAppRequestOptions = {}): Promise<McpAppToolDescriptor[]> {
    const pooled = await this.acquireEligible(serverId, options)
    const raw = await pooled.manager.listToolsRaw(serverId, options)
    await this.assertStillOwned(serverId, pooled, options)
    return raw.map(toAppToolDescriptor)
  }

  /**
   * 调用工具并保留原始 `_meta` / `structuredContent`。
   *
   * 模型可见的文本仍在 `text` 里；`resourceUri` / `structuredContent` 只给界面，
   * 是否进模型上下文由上层决定（对齐方案 I-06）。
   */
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

  /** 读取 App 页面资源；MIME 与体积都按最严校验。 */
  async readResource(serverId: string, uri: string, options: McpAppRequestOptions = {}): Promise<McpAppResource> {
    const pooled = await this.acquireEligible(serverId, options)
    const raw = await pooled.manager.readResource(serverId, uri, options)
    await this.assertStillOwned(serverId, pooled, options)
    return this.normalizeResource(uri, raw)
  }

  /**
   * 显式对账：不连接，只按**当前配置 + pi 侧事实**决定「该不该保留已有连接」。
   *
   * 用于宿主配置变化 / 归属切换 / 项目登记变化 / 退出前——凡是手工改了配置、
   * 单靠「下次请求时才校验」无法立刻断开旧连接的地方，都要显式调用它。
   */
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

  /** 对账所有「配置里出现过」或「池里还留着」的服务。 */
  async reconcileAll(): Promise<McpAppReconcileResult[]> {
    const ids = new Set<string>(this.pool.keys())
    for (const server of loadMcpServers(this.env).servers) ids.add(server.id)
    const results: McpAppReconcileResult[] = []
    for (const serverId of ids) results.push(await this.reconcile(serverId))
    return results
  }

  /** 断开单个服务的池连接并清缓存；返回此前是否存在。 */
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
    /* csp 可能挂在内容项的 `_meta.ui`，也可能挂在结果级 `_meta.ui`；两处都认。 */
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

/**
 * 主进程启动时注入归属守卫（缺省 fail-closed）。
 * 可在宿主已创建后再调用：会同时替换现有单例的守卫。
 */
export function configureMcpAppHostOwnership(ownership: McpAppOwnershipGuard | McpAppOwnershipFactsSource): void {
  const guard = ownership instanceof McpAppOwnershipGuard ? ownership : new McpAppOwnershipGuard(ownership)
  sharedOwnership = guard
  sharedHost?.setOwnership(guard)
}

/** 进程级单例：主进程、能力端点与 App 渲染共用同一份连接池。 */
export function mcpAppHost(): McpAppHost {
  if (!sharedHost) sharedHost = new McpAppHost({ ownership: sharedOwnership ?? {} })
  return sharedHost
}

/** 应用退出 / 测试收尾：关闭并丢弃单例。 */
export async function closeMcpAppHost(): Promise<void> {
  const host = sharedHost
  sharedHost = undefined
  if (host) await host.close()
}
