import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { type ClientCapabilities } from '@modelcontextprotocol/sdk/types.js'
import type { McpServerConfig, McpServerStatus, McpToolDescriptor } from '../../shared/mcp'
import { sharedResources, INTERACTIVE_RESOURCE } from '../interactive-resources'
import { WINDOWS_MCP_SERVER_ID } from '../../shared/mcp-native-import'

const WINDOWS_MCP_CONNECT_TIMEOUT_MS = 60_000
const WINDOWS_MCP_OBSERVE_TOOLS = new Set(['Snapshot', 'Screenshot', 'DisplayInventory', 'Wait', 'WaitFor'])

interface Connection {
  config: McpServerConfig
  client: Client | null
  status: McpServerStatus
  error?: string
  tools?: McpToolDescriptor[]
  transport?: { close(): Promise<void> }
  generation: number
  transportError?: unknown
  connecting?: Promise<void>
}

function isTransportFailure(
  client: Client,
  conn: Connection,
  transportErrorBeforeRequest: unknown
): boolean {
  if (conn.transportError !== transportErrorBeforeRequest) return true
  return client.transport === undefined
}

export class McpConnectionCancelledError extends Error {
  constructor() {
    super('MCP 连接已由用户取消')
    this.name = 'McpConnectionCancelledError'
  }
}

export interface McpRequestOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

export class McpRequestCancelledError extends Error {
  readonly code = 'request-cancelled'
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'McpRequestCancelledError'
  }
}

export interface McpRawToolDescriptor {
  name: string
  description?: string
  inputSchema?: unknown
  annotations?: unknown
  meta?: Record<string, unknown>
}

function looksLikeAuthFailure(message: string): boolean {
  return /\b401\b|\b403\b|unauthor|forbidden|invalid[_ ]token|api[_ ]?key|needs?[-_ ]auth/i.test(message)
}

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

export interface McpCloseOutcome {
  confirmed: boolean
  unknown: number
}

export class McpConnectionManager {
  private readonly connections = new Map<string, Connection>()

  constructor(
    configs: readonly McpServerConfig[],
    private readonly timeoutMs = 20_000,
    private readonly capabilities: ClientCapabilities = {}
  ) {
    for (const config of configs) {
      this.connections.set(config.id, { config, client: null, status: 'disconnected', generation: 0 })
    }
  }

  private readonly toolCache = new Map<string, { tools: McpToolDescriptor[]; at: number }>()

  list(): McpServerConfig[] {
    return [...this.connections.values()].map((c) => c.config)
  }

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

  syncServers(configs: readonly McpServerConfig[]): Array<{ serverId: string; release: Promise<McpCloseOutcome> }> {
    const wanted = new Map(configs.map((config) => [config.id, config]))
    const releases: Array<{ serverId: string; release: Promise<McpCloseOutcome> }> = []
    for (const id of [...this.connections.keys()]) {
      const conn = this.connections.get(id)!
      const next = wanted.get(id)
      if (next && sameConnectionConfig(conn.config, next)) {
        conn.config = next
        continue
      }
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

  private async withTimeout<T>(
    work: Promise<T>,
    what: string,
    onTimeout?: () => Promise<void>,
    timeoutMs = this.timeoutMs
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${what} 超时（${timeoutMs}ms）`))
        void onTimeout?.().catch(() => undefined)
      }, timeoutMs)
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
        client.onerror = (error) => {
          if (conn.client === client) conn.transportError = error
        }
        client.onclose = () => {
          if (conn.client !== client) return
          conn.client = null
          conn.transport = undefined
          conn.status = 'disconnected'
          conn.error = undefined
          conn.transportError = undefined
          this.toolCache.delete(conn.config.id)
        }
        await this.withTimeout(
          client.connect(transport),
          `连接 ${conn.config.id}`,
          () => this.cancelConnection(conn),
          conn.config.id === WINDOWS_MCP_SERVER_ID ? Math.max(this.timeoutMs, WINDOWS_MCP_CONNECT_TIMEOUT_MS) : this.timeoutMs
        )
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

  async disconnect(serverId: string): Promise<boolean> {
    const conn = this.connections.get(serverId)
    if (!conn) return false
    await this.cancelConnection(conn)
    return true
  }

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
    this.toolCache.delete(conn.config.id)
    if (client) await client.close().catch(() => undefined)
    else if (transport) await transport.close().catch(() => undefined)
  }

  private assertRequestAllowed(options: McpRequestOptions): void {
    if (options.signal?.aborted) {
      throw new McpRequestCancelledError('MCP 请求在发出前已被取消', options.signal.reason)
    }
  }

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

  async listToolsCached(serverId: string, options: { ttlMs?: number; refresh?: boolean } = {}) {
    const ttlMs = options.ttlMs ?? 60_000
    if (!options.refresh) {
      const cached = this.toolCache.get(serverId)
      if (cached && Date.now() - cached.at < ttlMs) {
        const conn = this.connections.get(serverId)
        if (conn) conn.tools = cached.tools
        return cached.tools
      }
    }
    const tools = await this.listTools(serverId)
    this.toolCache.set(serverId, { tools, at: Date.now() })
    return tools
  }

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

  async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    options: McpRequestOptions = {}
  ): Promise<unknown> {
    this.assertRequestAllowed(options)
    if (serverId === WINDOWS_MCP_SERVER_ID) {
      return sharedResources.run(INTERACTIVE_RESOURCE, `mcp:${serverId}`, async () => {
        await this.connect(this.require(serverId))
        try { return await this.callToolUncoordinated(serverId, toolName, args, options) }
        catch (error) {
          if (!WINDOWS_MCP_OBSERVE_TOOLS.has(toolName)) sharedResources.markUncertain(INTERACTIVE_RESOURCE)
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

  async close(): Promise<void> {
    await this.closeConfirmed().catch(() => undefined)
  }
}
