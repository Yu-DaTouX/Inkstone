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
import type { McpServerConfig, McpServerStatus, McpToolDescriptor } from '../../shared/mcp'

interface Connection {
  config: McpServerConfig
  client: Client | null
  status: McpServerStatus
  /** 失败原因（如实展示，不吞）。 */
  error?: string
  tools?: McpToolDescriptor[]
  transport?: { close(): Promise<void> }
  generation: number
  /** 并发去重：同一服务的第二次调用等第一次握完手。 */
  connecting?: Promise<void>
}

export class McpConnectionCancelledError extends Error {
  constructor() {
    super('MCP 连接已由用户取消')
    this.name = 'McpConnectionCancelledError'
  }
}

/** 认证类失败的识别：MCP 的认证错误没有统一码，只能按 HTTP 语义认。 */
function looksLikeAuthFailure(message: string): boolean {
  return /\b401\b|\b403\b|unauthor|forbidden|invalid[_ ]token|api[_ ]?key|needs?[-_ ]auth/i.test(message)
}

export class McpConnectionManager {
  private readonly connections = new Map<string, Connection>()

  constructor(
    configs: readonly McpServerConfig[],
    private readonly timeoutMs = 20_000
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
    this.toolCache.delete(conn.config.id)
    if (client) await client.close().catch(() => undefined)
    else if (transport) await transport.close().catch(() => undefined)
  }

  private async connect(conn: Connection): Promise<void> {
    if (conn.client) return
    if (conn.connecting) return conn.connecting
    const generation = conn.generation
    conn.status = 'connecting'
    conn.connecting = (async () => {
      let transport: StdioClientTransport | StreamableHTTPClientTransport | undefined
      let client: Client | undefined
      try {
        transport = this.makeTransport(conn.config)
        conn.transport = transport
        client = new Client({ name: 'yan', version: '0.2.0' }, { capabilities: {} })
        await this.withTimeout(client.connect(transport), `连接 ${conn.config.id}`, () => this.cancelConnection(conn))
        if (generation !== conn.generation) {
          await client.close().catch(() => undefined)
          throw new McpConnectionCancelledError()
        }
        conn.client = client
        conn.transport = undefined
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
  private dropClient(conn: Connection, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    conn.client = null
    conn.connecting = undefined
    conn.status = looksLikeAuthFailure(message) ? 'needs-auth' : 'disconnected'
    conn.error = message
    /* 断线后工具表可能变了，缓存必须跟着失效，否则会拿到过期 schema。 */
    this.toolCache.delete(conn.config.id)
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
  async listTools(serverId: string): Promise<McpToolDescriptor[]> {
    const conn = this.require(serverId)
    await this.connect(conn)
    const generation = conn.generation
    try {
      const tools: McpToolDescriptor[] = []
      let cursor: string | undefined
      do {
        const page = await this.withTimeout(
          conn.client!.listTools(cursor ? { cursor } : undefined),
          `列出 ${serverId} 的工具`,
          () => this.cancelConnection(conn)
        )
        for (const tool of page.tools ?? []) {
          tools.push({
            name: tool.name,
            ...(tool.description ? { description: tool.description } : {}),
            ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
            annotations: (tool.annotations as McpToolDescriptor['annotations']) ?? null
          })
        }
        cursor = page.nextCursor
      } while (cursor)
      conn.tools = tools
      return tools
    } catch (error) {
      if (generation === conn.generation) this.dropClient(conn, error)
      throw error
    }
  }

  /** 调用工具。返回**原始**结果 —— 分类（工具错误 vs 协议错误）在 shared 层做。 */
  async callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const conn = this.require(serverId)
    await this.connect(conn)
    const generation = conn.generation
    try {
      return await this.withTimeout(
        conn.client!.callTool({ name: toolName, arguments: args }),
        `调用 ${serverId}/${toolName}`,
        () => this.cancelConnection(conn)
      )
    } catch (error) {
      if (generation === conn.generation) this.dropClient(conn, error)
      throw error
    }
  }

  async close(): Promise<void> {
    const closers: Promise<unknown>[] = []
    for (const conn of this.connections.values()) {
      conn.generation++
      const client = conn.client
      const transport = conn.transport
      conn.client = null
      conn.transport = undefined
      conn.connecting = undefined
      conn.status = 'disconnected'
      conn.tools = undefined
      if (client) closers.push(client.close().catch(() => undefined))
      else if (transport) closers.push(transport.close().catch(() => undefined))
    }
    this.toolCache.clear()
    await Promise.all(closers)
  }
}
