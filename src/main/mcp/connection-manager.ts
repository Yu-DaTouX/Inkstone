/**
 * MCP 连接管理（实施-04 §3 / §5）。
 *
 * ── 为什么用官方 SDK 而不是手写 JSON-RPC ──
 *   S1 预检已核实 pi **完全不内置 MCP**（文档 / 依赖树 / bundle 归属 / CLI+RPC 面四条证据），
 *   所以连接必须由砚自己建；而握手、能力协商、分页、工具错误约定这些细节
 *   自己实现一版就是重造一个会和官方漂移的轮子。SDK 版本用 `--save-exact` 锁死
 *   （§5：**不照抄 latest 标签**，装完先验 API 再固定）。
 *
 * ── 生命周期原则 ──
 *   懒连接（第一次真的要用它时才起进程）、失败**不静默**（状态与原因都留在
 *   `statusOf()` 里，让上层能如实显示「需要认证」而不是「不可用」）、
 *   并发去重（同一服务同时被两处调用只连一次）。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { type ClientCapabilities } from '@modelcontextprotocol/sdk/types.js'
import type { McpServerConfig, McpServerStatus, McpToolDescriptor } from '../../shared/mcp'
import { sharedResources, INTERACTIVE_RESOURCE } from '../agent-hub/resources'

interface Connection {
  config: McpServerConfig
  client: Client | null
  status: McpServerStatus
  /** 失败原因（如实展示，不吞）。 */
  error?: string
  tools?: McpToolDescriptor[]
  transport?: { close(): Promise<void> }
  generation: number
  /**
   * 该连接最近一次 transport 级 `onerror`。请求失败时用它区分「请求级错误
   * （服务端 JSON-RPC 错误等，连接还活着）和「连接真的坏了」。重连 / 释放时清空。
   */
  transportError?: unknown
  /** 并发去重：同一服务的第二次调用等第一次握完手。 */
  connecting?: Promise<void>
}

/** 连接级失败：本请求期间报过 transport error，或 SDK 已把内部 transport 置空。 */
function isTransportFailure(
  client: Client,
  conn: Connection,
  transportErrorBeforeRequest: unknown
): boolean {
  /*
   * 不能只看 error.code === -32000（SDK 的 ConnectionClosed）：
   * 服务端可以把正常的应用/工具错误也编成 -32000，而此时 transport 仍活着。
   * 只认两种本地可核实的 transport 生命周期事实：
   *   1. 本次请求期间新发生的 transport onerror；
   *   2. SDK 在 onclose/close 时把 client.transport 置空（真实断线的可靠信号）。
   */
  if (conn.transportError !== transportErrorBeforeRequest) return true
  return client.transport === undefined
}

export class McpConnectionCancelledError extends Error {
  constructor() {
    super('MCP 连接已由用户取消')
    this.name = 'McpConnectionCancelledError'
  }
}

/** 单次请求的可选控制：`signal` 中止时由 SDK 发 `notifications/cancelled` 并拒掉本次请求。 */
export interface McpRequestOptions {
  signal?: AbortSignal
  /** 只覆盖本次请求（分页时是每页）的超时毫秒数；缺省用管理器超时。用于注入极短超时做隔离验证。 */
  timeoutMs?: number
}

/**
 * 单次请求被用户取消或本调用级超时：**连接保持可用**，同一连接上的其他请求不受影响。
 * 与 `McpConnectionCancelledError`（握手被取消、整条连接作废）区分。
 */
export class McpRequestCancelledError extends Error {
  readonly code = 'request-cancelled'
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'McpRequestCancelledError'
  }
}

/**
 * `tools/list` 的原始单项：保留 `_meta`（MCP Apps 的 `_meta.ui` 就在这里）。
 * 归一化的 `McpToolDescriptor` 会丢 `_meta`，所以 MCP Apps 宿主另走这条。
 */
export interface McpRawToolDescriptor {
  name: string
  description?: string
  inputSchema?: unknown
  annotations?: unknown
  meta?: Record<string, unknown>
}

/** 认证类失败的识别：MCP 的认证错误没有统一码，只能按 HTTP 语义认。 */
function looksLikeAuthFailure(message: string): boolean {
  return /\b401\b|\b403\b|unauthor|forbidden|invalid[_ ]token|api[_ ]?key|needs?[-_ ]auth/i.test(message)
}

/** 一个 serverId 的成员是否仍是同一份连接配置（只比连接字段，不比 title 等展示字段）。 */
function sameConnectionConfig(a: McpServerConfig, b: McpServerConfig): boolean {
  return (
    a.transport === b.transport &&
    a.command === b.command &&
    a.url === b.url &&
    (a.enabled !== false) === (b.enabled !== false) &&
    JSON.stringify(a.args ?? null) === JSON.stringify(b.args ?? null) &&
    JSON.stringify(a.env ?? null) === JSON.stringify(b.env ?? null)
  )
}

/** 关闭一批连接的**如实**结果：`unknown` > 0 表示至少一条没能确认关闭。 */
export interface McpCloseOutcome {
  confirmed: boolean
  unknown: number
}

export class McpConnectionManager {
  private readonly connections = new Map<string, Connection>()

  constructor(
    configs: readonly McpServerConfig[],
    private readonly timeoutMs = 20_000,
    /** 客户端能力声明；MCP Apps 宿主用它在 `initialize` 声明 ui 扩展，普通调用方保持 `{}`。 */
    private readonly capabilities: ClientCapabilities = {}
  ) {
    for (const config of configs) {
      this.connections.set(config.id, { config, client: null, status: 'disconnected', generation: 0 })
    }
  }

  /** 工具表缓存：工具名列表是发现 MCP 能力的唯一入口，而 listTools 要连服务。 */
  private readonly toolCache = new Map<string, { tools: McpToolDescriptor[]; at: number }>()

  list(): McpServerConfig[] {
    return [...this.connections.values()].map((c) => c.config)
  }

  /** 同步摘掉一个成员的连接，并把它的 transport 释放 Promise 交回调用方 await。 */
  private detachAndRelease(conn: Connection): Promise<McpCloseOutcome> {
    conn.generation++
    const client = conn.client
    const transport = conn.transport
    conn.client = null
    conn.transport = undefined
    conn.connecting = undefined
    conn.status = 'disconnected'
    conn.error = undefined
    conn.tools = undefined
    conn.transportError = undefined
    if (!client && !transport) return Promise.resolve({ confirmed: true, unknown: 0 })
    const closer = client ? client.close() : (transport as { close(): Promise<void> }).close()
    return closer.then(
      () => ({ confirmed: true, unknown: 0 }),
      () => ({ confirmed: false, unknown: 1 })
    )
  }

  /**
   * 按最新配置**原地**协调成员：只增删差异，不重建整个 manager。
   *
   * 为什么不是重建：旧 manager 里未变化的 legacy 成员（例如 B）仍持有活连接，
   * 新 manager 会对同一个 B 再连一条 —— 双连接。这里只把不再需要的成员（例如
   * 转为砚托管的 A）摘掉，B 的连接原样保留；返回的 release 供调用方 await，
   * 在确认关闭前不得把 A 交给宿主。**不建第二份注册表。**
   */
  syncServers(configs: readonly McpServerConfig[]): Array<{ serverId: string; release: Promise<McpCloseOutcome> }> {
    const wanted = new Map(configs.map((config) => [config.id, config]))
    const releases: Array<{ serverId: string; release: Promise<McpCloseOutcome> }> = []
    for (const id of [...this.connections.keys()]) {
      const conn = this.connections.get(id)!
      const next = wanted.get(id)
      if (next && sameConnectionConfig(conn.config, next)) continue
      this.connections.delete(id)
      this.toolCache.delete(id)
      releases.push({ serverId: id, release: this.detachAndRelease(conn) })
    }
    for (const config of configs) {
      if (!this.connections.has(config.id)) {
        this.connections.set(config.id, { config, client: null, status: 'disconnected', generation: 0 })
      }
    }
    return releases
  }

  listServerIds(): string[] {
    return [...this.connections.keys()]
  }

  statusOf(serverId: string): { status: McpServerStatus; error?: string } {
    const conn = this.connections.get(serverId)
    if (!conn) return { status: 'error', error: `没有登记这个 MCP 服务：${serverId}` }
    return { status: conn.status, ...(conn.error ? { error: conn.error } : {}) }
  }

  toolCountOf(serverId: string): number | null {
    return this.connections.get(serverId)?.tools?.length ?? null
  }

  /** 带硬超时：一次握手挂住不该让整个回合哑掉。 */
  private async withTimeout<T>(work: Promise<T>, what: string, onTimeout?: () => Promise<void>): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${what} 超时（${this.timeoutMs}ms）`))
        void onTimeout?.().catch(() => undefined)
      }, this.timeoutMs)
    })
    try {
      return await Promise.race([work, timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private makeTransport(config: McpServerConfig) {
    if (config.transport === 'stdio') {
      if (!config.command) throw new Error(`MCP 服务 ${config.id} 缺少 command`)
      /*
       * MCP 服务是第三方代码。不能把桌面进程的全部环境（尤其是 token）无差别
       * 传给它；只给它运行 Node / Windows 所需的基础变量，额外变量必须在受管
       * 配置里逐项声明。这样本地包与手写 stdio 服务遵守同一条边界。
       */
      const allow = [
        'PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE',
        'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'ComSpec', 'PATHEXT'
      ]
      const protectedKeys = new Set([
        'PATH', 'PATHEXT', 'COMSPEC', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP',
        'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE'
      ])
      const env: Record<string, string> = {}
      for (const key of allow) {
        const value = process.env[key]
        if (typeof value === 'string') env[key] = value
      }
      for (const [key, value] of Object.entries(config.env ?? {})) {
        const normalized = key.toUpperCase()
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || protectedKeys.has(normalized)) {
          throw new Error(`MCP 服务 ${config.id} 不能覆盖受保护的环境变量：${key}`)
        }
        if (typeof value !== 'string') {
          throw new Error(`MCP 服务 ${config.id} 的环境变量 ${key} 不是字符串`)
        }
        env[key] = value
      }
      return new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        env,
        stderr: 'ignore'
      })
    }
    if (!config.url) throw new Error(`MCP 服务 ${config.id} 缺少 url`)
    return new StreamableHTTPClientTransport(new URL(config.url))
  }

  private require(serverId: string): Connection {
    const conn = this.connections.get(serverId)
    if (!conn) throw new Error(`没有登记这个 MCP 服务：${serverId}`)
    if (conn.config.enabled === false) throw new Error(`MCP 服务 ${serverId} 已在配置里禁用`)
    return conn
  }

  /** 超时也必须释放底层 transport；只让 Promise.race 返回会留下挂起的子进程 / HTTP 请求。 */
  private async cancelConnection(conn: Connection): Promise<void> {
    conn.generation++
    const client = conn.client
    const transport = conn.transport
    conn.client = null
    conn.transport = undefined
    conn.connecting = undefined
    conn.tools = undefined
    conn.status = 'disconnected'
    conn.error = undefined
    conn.transportError = undefined
    this.toolCache.delete(conn.config.id)
    if (client) await client.close().catch(() => undefined)
    else if (transport) await transport.close().catch(() => undefined)
  }

  private async connect(conn: Connection): Promise<void> {
    if (conn.client) return
    if (conn.connecting) return conn.connecting
    const generation = conn.generation
    conn.status = 'connecting'
    conn.transportError = undefined
    conn.connecting = (async () => {
      let transport: StdioClientTransport | StreamableHTTPClientTransport | undefined
      let client: Client | undefined
      try {
        transport = this.makeTransport(conn.config)
        conn.transport = transport
        client = new Client({ name: 'yan', version: '0.2.0' }, { capabilities: this.capabilities })
        /* 只记当前活动 client 的 transport 错误；旧 client 的迟到事件不能污染新连接。 */
        client.onerror = (error) => {
          if (conn.client === client) conn.transportError = error
        }
        /*
         * 绑定 onclose：SDK 在 transport 关闭（含服务空闲退出）时先把 client.transport
         * 置空再回调。只回收仍是当前活动 client 的那一个，避免旧 client 的迟到 onclose
         * 误伤重连后的新连接；显式 disconnect/close/dropClient 都先清 conn.client，
         * 因此这类主动关闭不会被这里重复回收，也不留挂起连接。
         */
        client.onclose = () => {
          if (conn.client !== client) return
          conn.client = null
          conn.transport = undefined
          conn.status = 'disconnected'
          conn.error = undefined
          conn.transportError = undefined
          this.toolCache.delete(conn.config.id)
        }
        await this.withTimeout(client.connect(transport), `连接 ${conn.config.id}`, () => this.cancelConnection(conn))
        if (generation !== conn.generation) {
          await client.close().catch(() => undefined)
          throw new McpConnectionCancelledError()
        }
        conn.client = client
        conn.transport = transport
        conn.status = 'ready'
        conn.error = undefined
      } catch (error) {
        if (generation !== conn.generation) throw error
        const message = error instanceof Error ? error.message : String(error)
        if (client) await client.close().catch(() => undefined)
        else if (transport) await transport.close().catch(() => undefined)
        conn.client = null
        conn.transport = undefined
        conn.status = looksLikeAuthFailure(message) ? 'needs-auth' : 'error'
        conn.error = message
        throw error
      } finally {
        if (generation === conn.generation) conn.connecting = undefined
      }
    })()
    return conn.connecting
  }

  /** 用户主动取消握手或断开连接；该操作只影响此 runner 的对应 serverId。 */
  async disconnect(serverId: string): Promise<boolean> {
    const conn = this.connections.get(serverId)
    if (!conn) return false
    await this.cancelConnection(conn)
    return true
  }

  /** 断线后立刻反映到状态上：下一次调用会重新握手，而不是拿死连接一直报错。 */
  private async dropClient(conn: Connection, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error)
    const client = conn.client
    const transport = conn.transport
    conn.client = null
    conn.transport = undefined
    conn.connecting = undefined
    conn.status = looksLikeAuthFailure(message) ? 'needs-auth' : 'disconnected'
    conn.error = message
    conn.transportError = undefined
    /* 断线后工具表可能变了，缓存必须跟着失效，否则会拿到过期 schema。 */
    this.toolCache.delete(conn.config.id)
    if (client) await client.close().catch(() => undefined)
    else if (transport) await transport.close().catch(() => undefined)
  }

  /** 发请求前先看外部信号：已中止就 fail-closed，不为一个取消了的调用去建连接。 */
  private assertRequestAllowed(options: McpRequestOptions): void {
    if (options.signal?.aborted) {
      throw new McpRequestCancelledError('MCP 请求在发出前已被取消', options.signal.reason)
    }
  }

  /**
   * 单次请求（或分页中的一页）的调用外壳。
   *
   * 为什么需要它：旧的 `withTimeout(..., () => cancelConnection(conn))` + catch 里
   * `dropClient` 会把「某一次请求被取消/超时」当成「整条连接坏了」，于是 A 取消会
   * 拆掉 B 正在用的共享连接。这里把外部 `AbortSignal` 与本调用的超时合并进一个独立
   * controller：中止只让 SDK 发 `notifications/cancelled` 并拒掉本次请求，连接保持
   * ready，同一连接上的其他请求不受影响。只有确认连接真的死了（SDK ConnectionClosed /
   * transport `onerror` / 内部 transport 被置空）才释放连接，其余请求级错误（如服务端
   * JSON-RPC 错误）保留健康连接。定时器与外部监听器在结束时清掉，不会留下未处理的 promise。
   */
  private async runRequest<T>(
    conn: Connection,
    client: Client,
    options: McpRequestOptions,
    what: string,
    run: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    this.assertRequestAllowed(options)
    const external = options.signal
    const controller = new AbortController()
    let cancelled = false
    let cancelReason: unknown
    const cancelThis = (reason: unknown): void => {
      if (controller.signal.aborted) return
      cancelled = true
      cancelReason = reason
      controller.abort(reason)
    }
    const onExternalAbort = (): void => cancelThis(external?.reason)
    if (external) external.addEventListener('abort', onExternalAbort, { once: true })
    let timer: NodeJS.Timeout | undefined
    const timeoutMs = options.timeoutMs ?? this.timeoutMs
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => cancelThis(new McpRequestCancelledError(`${what} 超时（${timeoutMs}ms）`)), timeoutMs)
    }
    const transportErrorBeforeRequest = conn.transportError
    try {
      return await run(controller.signal)
    } catch (error) {
      if (isTransportFailure(client, conn, transportErrorBeforeRequest)) {
        if (conn.client === client) await this.dropClient(conn, error)
        throw error
      }
      if (cancelled) {
        throw cancelReason instanceof McpRequestCancelledError
          ? cancelReason
          : new McpRequestCancelledError(`${what} 已取消`, error)
      }
      throw error
    } finally {
      if (timer) clearTimeout(timer)
      if (external) external.removeEventListener('abort', onExternalAbort)
    }
  }

  /**
   * 带 TTL 的工具表（实施-04 S4）。
   *
   * 为什么需要缓存：能力目录（`yan capabilities search`）每次都要工具表，
   * 而每个 `listTools` 都要连一次服务 —— 没有缓存时「模型多搜几次」
   * 就等于反复起子进程 / 发 HTTP。断线、显式刷新（`refresh=true`）都会绕过或清掉它。
   */
  async listToolsCached(serverId: string, options: { ttlMs?: number; refresh?: boolean } = {}) {
    const ttlMs = options.ttlMs ?? 60_000
    if (!options.refresh) {
      const cached = this.toolCache.get(serverId)
      if (cached && Date.now() - cached.at < ttlMs) return cached.tools
    }
    const tools = await this.listTools(serverId)
    this.toolCache.set(serverId, { tools, at: Date.now() })
    return tools
  }

  /**
   * 列出工具（**跟随分页**）。
   *
   * 不跟分页的写法在「只有几个工具」的 fixture 上永远是绿的，遇到真实服务
   * 就会静默少列一半 —— 那正是 §13.1「分页」要挡的。
   */
  async listTools(serverId: string, options: McpRequestOptions = {}): Promise<McpToolDescriptor[]> {
    const raw = await this.listToolsRaw(serverId, options)
    const tools: McpToolDescriptor[] = raw.map((tool) => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
      annotations: (tool.annotations as McpToolDescriptor['annotations']) ?? null
    }))
    const conn = this.connections.get(serverId)
    if (conn) conn.tools = tools
    return tools
  }

  /** 与 `listTools` 同一条分页路径，但不丢 `_meta` / `annotations` 原始形状（MCP Apps 宿主用）。 */
  async listToolsRaw(serverId: string, options: McpRequestOptions = {}): Promise<McpRawToolDescriptor[]> {
    this.assertRequestAllowed(options)
    const conn = this.require(serverId)
    await this.connect(conn)
    const client = conn.client
    if (!client) throw new McpConnectionCancelledError()
    const tools: McpRawToolDescriptor[] = []
    let cursor: string | undefined
    do {
      const page = await this.runRequest(conn, client, options, `列出 ${serverId} 的工具`, (signal) =>
        client.listTools(cursor ? { cursor } : undefined, { signal })
      )
      for (const tool of page.tools ?? []) {
        tools.push({
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
          ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
          ...(tool._meta !== undefined ? { meta: tool._meta as Record<string, unknown> } : {})
        })
      }
      cursor = page.nextCursor
    } while (cursor)
    return tools
  }

  /** 读取资源（MCP Apps 用它取 `ui://` 页面）；返回**原始**结果，含 `_meta`。 */
  async readResource(serverId: string, uri: string, options: McpRequestOptions = {}): Promise<unknown> {
    this.assertRequestAllowed(options)
    const conn = this.require(serverId)
    await this.connect(conn)
    const client = conn.client
    if (!client) throw new McpConnectionCancelledError()
    return this.runRequest(conn, client, options, `读取 ${serverId} 的资源 ${uri}`, (signal) =>
      client.readResource({ uri }, { signal })
    )
  }

  /** 调用工具。返回**原始**结果 —— 分类（工具错误 vs 协议错误）在 shared 层做。 */
  async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    options: McpRequestOptions = {}
  ): Promise<unknown> {
    this.assertRequestAllowed(options)
    if (serverId === 'windows-mcp') {
      return sharedResources.run(INTERACTIVE_RESOURCE, `mcp:${serverId}`, async () => {
        // 连接尚未建成时没有发出桌面动作，不隔离资源。
        await this.connect(this.require(serverId))
        try { return await this.callToolUncoordinated(serverId, toolName, args, options) }
        catch (error) {
          // 断连与超时不能撤回已发送的输入；确认旧 worker 停止前不转交资源。
          sharedResources.markUncertain(INTERACTIVE_RESOURCE)
          throw error
        }
      })
    }
    return this.callToolUncoordinated(serverId, toolName, args, options)
  }

  private async callToolUncoordinated(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    options: McpRequestOptions = {}
  ): Promise<unknown> {
    this.assertRequestAllowed(options)
    const conn = this.require(serverId)
    await this.connect(conn)
    const client = conn.client
    if (!client) throw new McpConnectionCancelledError()
    return this.runRequest(conn, client, options, `调用 ${serverId}/${toolName}`, (signal) =>
      client.callTool({ name: toolName, arguments: args }, undefined, { signal })
    )
  }

  /**
   * 关闭所有成员并**如实回报**是否有连接没能确认关闭。
   *
   * `close()` 把每条连接的错误吞掉只为「尽力回收」；归属迁移必须知道旧连接
   * 到底有没有确认释放，不能因为 Promise 没抛错就当作旧持有者已经消失。
   */
  async closeConfirmed(): Promise<McpCloseOutcome> {
    const closers: Promise<McpCloseOutcome>[] = []
    for (const conn of this.connections.values()) {
      closers.push(this.detachAndRelease(conn))
    }
    this.toolCache.clear()
    const outcomes = await Promise.all(closers)
    const unknown = outcomes.reduce((sum, outcome) => sum + outcome.unknown, 0)
    return { confirmed: unknown === 0, unknown }
  }

  /** 尽力关闭（沿用既有语义：错误吞掉，只保证把内存状态清干净）。 */
  async close(): Promise<void> {
    await this.closeConfirmed().catch(() => undefined)
  }
}
