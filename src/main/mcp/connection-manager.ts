import { pick } from '../../shared/ui-lang'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioTreeClientTransport } from './stdio-tree-transport'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ToolListChangedNotificationSchema, type ClientCapabilities } from '@modelcontextprotocol/sdk/types.js'
import type { McpServerConfig, McpServerStatus, McpToolDescriptor } from '../../shared/mcp'
import { sharedResources, INTERACTIVE_RESOURCE } from '../interactive-resources'
import { WINDOWS_MCP_SERVER_ID } from '../../shared/mcp-native'
import { windowsMcpKeepsProcess } from './windows-mcp-tree'

const WINDOWS_MCP_CONNECT_TIMEOUT_MS = 60_000
const WINDOWS_MCP_OBSERVE_TOOLS = new Set(['Snapshot', 'Screenshot', 'DisplayInventory', 'Wait', 'WaitFor'])
const WINDOWS_MCP_CONTROL_TOOL = 'ControlStatus'
const WINDOWS_MCP_RELEASE_TIMEOUT_MS = 3_000
const WINDOWS_MCP_IDLE_RELEASE_MS = 15_000

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
  inflight?: Set<(reason: unknown) => void>
}

function stderrTailOf(transport: unknown): string {
  return transport instanceof StdioTreeClientTransport ? transport.stderrTail() : ''
}

function withStderr(message: string, tail: string): string {
  return tail ? `${message}\n${pick('服务输出（stderr）：', 'Server output (stderr):')}\n${tail}` : message
}

function isTransportFailure(
  client: Client,
  conn: Connection,
  transportErrorBeforeRequest: unknown
): boolean {
  if (conn.transportError !== transportErrorBeforeRequest) return true
  return client.transport === undefined
}

const controlHolders = new Set<McpConnectionManager>()
const MAX_TOOL_LIST_PAGES = 50
const MAX_TOOL_LIST_ITEMS = 2000

export class McpConnectionCancelledError extends Error {
  constructor() {
    super(pick('MCP 连接已由用户取消', 'MCP connection canceled by the user'))
    this.name = 'McpConnectionCancelledError'
  }
}

export interface McpConnectionPin {
  readonly serverId: string
  readonly conn: object
  readonly epoch: number
}

export interface McpRequestOptions {
  signal?: AbortSignal
  connection?: McpConnectionPin
  timeoutMs?: number
  longRunning?: boolean
}

export const MCP_LONG_CALL_IDLE_TIMEOUT_MS = 10 * 60_000
export const MCP_LONG_CALL_TOTAL_TIMEOUT_MS = 60 * 60_000

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
    a.url === b.url && a.cwd === b.cwd && JSON.stringify(a.headers ?? null) === JSON.stringify(b.headers ?? null) &&
    (a.enabled !== false) === (b.enabled !== false) &&
    JSON.stringify(a.args ?? null) === JSON.stringify(b.args ?? null) &&
    JSON.stringify(a.env ?? null) === JSON.stringify(b.env ?? null)
  )
}

export interface McpCloseOutcome {
  confirmed: boolean
  unknown: number
}

export interface McpSyncServersOptions {
  cancelInFlight?: string
}

export class McpConnectionManager {
  private readonly connections = new Map<string, Connection>()
  private heldControl = false
  private get computerControlHeld(): boolean {
    return this.heldControl
  }
  private set computerControlHeld(value: boolean) {
    this.heldControl = value
    if (value) controlHolders.add(this)
    else controlHolders.delete(this)
  }
  private computerEpoch = 0
  private activeInputCalls = 0
  private releaseAfterInput = false
  private idleRelease?: NodeJS.Timeout
  computerIdleReleaseMs = WINDOWS_MCP_IDLE_RELEASE_MS

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
  private readonly toolsListChangedListeners = new Set<(serverId: string) => void>()
  private activeRequests = 0
  private idleWaiters: Array<() => void> = []

  onToolsListChanged(listener: (serverId: string) => void): () => void {
    this.toolsListChangedListeners.add(listener)
    return () => {
      this.toolsListChangedListeners.delete(listener)
    }
  }

  private handleToolsListChanged(conn: Connection, generation: number): void {
    if (generation !== conn.generation || this.connections.get(conn.config.id) !== conn) return
    conn.tools = undefined
    this.toolCache.delete(conn.config.id)
    for (const listener of [...this.toolsListChangedListeners]) {
      try {
        listener(conn.config.id)
      } catch (error) {
        console.warn('[mcp] tools/list_changed listener failed:', error instanceof Error ? error.message : String(error))
      }
    }
  }

  isBusy(): boolean {
    if (this.activeRequests > 0 || this.activeInputCalls > 0) return true
    for (const conn of this.connections.values()) if (conn.connecting) return true
    return false
  }

  onceIdle(callback: () => void): void {
    if (!this.isBusy()) {
      callback()
      return
    }
    this.idleWaiters.push(callback)
  }

  private settleIdle(): void {
    if (this.idleWaiters.length === 0 || this.isBusy()) return
    const waiters = this.idleWaiters
    this.idleWaiters = []
    for (const waiter of waiters) waiter()
  }

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

  private cancelInFlight(conn: Connection, message: string): void {
    const reason = new McpRequestCancelledError(message)
    for (const cancel of [...(conn.inflight ?? [])]) cancel(reason)
  }

  clearIdleWaiters(): void {
    this.idleWaiters = []
  }

  syncServers(configs: readonly McpServerConfig[], options: McpSyncServersOptions = {}): Array<{ serverId: string; release: Promise<McpCloseOutcome> }> {
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
      const stopMessage = options.cancelInFlight ?? (id === WINDOWS_MCP_SERVER_ID ? pick('电脑操作的连接已被移除或更换，进行中的电脑操作已中止', 'The computer-use connection was removed or replaced; the computer action in progress was aborted') : undefined)
      if (stopMessage) this.cancelInFlight(conn, stopMessage)
      releases.push({ serverId: id, release: this.releaseThenDetach(conn) })
    }
    for (const config of configs) {
      if (!this.connections.has(config.id)) {
        this.connections.set(config.id, { config, client: null, status: 'disconnected', generation: 0 })
      }
    }
    return releases
  }

  pinConnection(serverId: string): McpConnectionPin | undefined {
    const conn = this.connections.get(serverId)
    return conn ? { serverId, conn, epoch: this.computerEpoch } : undefined
  }

  private assertPinCurrent(pin: McpConnectionPin | undefined): void {
    if (!pin) return
    if (this.connections.get(pin.serverId) === pin.conn && pin.epoch === this.computerEpoch) return
    throw new McpRequestCancelledError(pick('权限已调低，操作已中止', 'Permissions were tightened; the operation was aborted'))
  }

  abortComputerCalls(message: string): void {
    this.computerEpoch++
    const conn = this.connections.get(WINDOWS_MCP_SERVER_ID)
    if (!conn) return
    this.cancelInFlight(conn, message)
    void this.releaseComputerControl().catch(() => undefined)
  }

  listServerIds(): string[] {
    return [...this.connections.keys()]
  }

  statusOf(serverId: string): { status: McpServerStatus; error?: string } {
    const conn = this.connections.get(serverId)
    if (!conn) return { status: 'error', error: pick(`没有登记这个 MCP 服务：${serverId}`, `MCP service not registered: ${serverId}`) }
    return { status: conn.status, ...(conn.error ? { error: conn.error } : {}) }
  }

  toolCountOf(serverId: string): number | null {
    return this.connections.get(serverId)?.tools?.length ?? null
  }

  private async withTimeout<T>(
    work: Promise<T>,
    what: string,
    onTimeout?: (error: Error) => Promise<void>,
    timeoutMs = this.timeoutMs,
    suffix?: () => string
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(withStderr(pick(`${what} 超时（${timeoutMs}ms）`, `${what} timed out (${timeoutMs}ms)`), suffix?.() ?? ''))
        reject(error)
        void onTimeout?.(error).catch(() => undefined)
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
      if (!config.command) throw new Error(pick(`MCP 服务 ${config.id} 缺少 command`, `MCP service ${config.id} is missing command`))
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
          throw new Error(pick(`MCP 服务 ${config.id} 不能覆盖受保护的环境变量：${key}`, `MCP service ${config.id} cannot override the protected environment variable: ${key}`))
        }
        if (typeof value !== 'string') {
          throw new Error(pick(`MCP 服务 ${config.id} 的环境变量 ${key} 不是字符串`, `Environment variable ${key} of MCP service ${config.id} is not a string`))
        }
        env[key] = value
      }
      return new StdioTreeClientTransport({
        command: config.command,
        args: config.args ?? [],
        env,
        cwd: config.cwd
      }, undefined, undefined, undefined, {
        secretValues: Object.values(config.env ?? {}).filter((value): value is string => typeof value === 'string'),
        ...(config.id === WINDOWS_MCP_SERVER_ID ? { keep: windowsMcpKeepsProcess } : {})
      })
    }
    if (!config.url) throw new Error(pick(`MCP 服务 ${config.id} 缺少 url`, `MCP service ${config.id} is missing url`))
    return new StreamableHTTPClientTransport(new URL(config.url), config.headers ? { requestInit: { headers: config.headers, redirect: 'error' } } : undefined)
  }

  private require(serverId: string): Connection {
    const conn = this.connections.get(serverId)
    if (!conn) throw new Error(pick(`没有登记这个 MCP 服务：${serverId}`, `MCP service not registered: ${serverId}`))
    if (conn.config.enabled === false) throw new Error(pick(`MCP 服务 ${serverId} 已在配置里禁用`, `MCP service ${serverId} is disabled in config`))
    return conn
  }

  private async cancelConnection(conn: Connection): Promise<void> {
    await this.releaseControlOn(conn)
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

  private async timeoutConnection(conn: Connection, timeoutError: Error, generation: number): Promise<void> {
    if (generation !== conn.generation) return
    await this.cancelConnection(conn)
    if (conn.generation === generation + 1 && !conn.client && !conn.connecting && conn.status === 'disconnected') {
      conn.status = 'error'
      conn.error = timeoutError.message
    }
  }

  private async connect(conn: Connection): Promise<void> {
    if (conn.client) return
    if (conn.connecting) return conn.connecting
    const generation = conn.generation
    conn.status = 'connecting'
    conn.transportError = undefined
    conn.connecting = (async () => {
      let transport: StdioTreeClientTransport | StreamableHTTPClientTransport | undefined
      let client: Client | undefined
      try {
        transport = this.makeTransport(conn.config)
        conn.transport = transport
        client = new Client({ name: 'yan', version: '0.2.0' }, { capabilities: this.capabilities })
        client.onerror = (error) => {
          if (conn.client === client) conn.transportError = error
        }
        client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
          this.handleToolsListChanged(conn, generation)
        })
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
          pick(`连接 ${conn.config.id}`, `Connecting ${conn.config.id}`),
          (timeoutError) => this.timeoutConnection(conn, timeoutError, generation),
          conn.config.id === WINDOWS_MCP_SERVER_ID ? Math.max(this.timeoutMs, WINDOWS_MCP_CONNECT_TIMEOUT_MS) : this.timeoutMs,
          () => stderrTailOf(transport)
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
        const rawMessage = error instanceof Error ? error.message : String(error)
        const tail = stderrTailOf(transport)
        const message = rawMessage.includes(tail) && tail ? rawMessage : withStderr(rawMessage, tail)
        if (client) await client.close().catch(() => undefined)
        else if (transport) await transport.close().catch(() => undefined)
        conn.client = null
        conn.transport = undefined
        conn.status = looksLikeAuthFailure(message) ? 'needs-auth' : 'error'
        conn.error = message
        throw message === rawMessage ? error : new Error(message, { cause: error })
      } finally {
        if (generation === conn.generation) conn.connecting = undefined
        this.settleIdle()
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
    const message = withStderr(error instanceof Error ? error.message : String(error), stderrTailOf(conn.transport))
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
      throw new McpRequestCancelledError(pick('MCP 请求在发出前已被取消', 'MCP request canceled before it was sent'), options.signal.reason)
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
      timer = setTimeout(() => cancelThis(new McpRequestCancelledError(pick(`${what} 超时（${timeoutMs}ms）`, `${what} timed out (${timeoutMs}ms)`))), timeoutMs)
    }
    const transportErrorBeforeRequest = conn.transportError
    this.activeRequests++
    const inflight = (conn.inflight ??= new Set())
    inflight.add(cancelThis)
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
          : new McpRequestCancelledError(pick(`${what} 已取消`, `${what} canceled`), error)
      }
      throw error
    } finally {
      if (timer) clearTimeout(timer)
      if (external) external.removeEventListener('abort', onExternalAbort)
      inflight.delete(cancelThis)
      this.activeRequests--
      this.settleIdle()
    }
  }

  async listToolsCached(serverId: string, options: McpRequestOptions & { ttlMs?: number; refresh?: boolean } = {}) {
    this.assertRequestAllowed(options)
    const ttlMs = options.ttlMs ?? 60_000
    if (!options.refresh) {
      const cached = this.toolCache.get(serverId)
      if (cached && Date.now() - cached.at < ttlMs) {
        const conn = this.connections.get(serverId)
        if (conn) conn.tools = cached.tools
        return cached.tools
      }
    }
    const tools = await this.listTools(serverId, options)
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
    const seenCursors = new Set<string>()
    let pages = 0
    do {
      if (++pages > MAX_TOOL_LIST_PAGES) throw new Error(pick(`${serverId} 的工具列表超过 ${MAX_TOOL_LIST_PAGES} 页，已停止读取`, `The tool list of ${serverId} exceeds ${MAX_TOOL_LIST_PAGES} pages. Stopped reading`))
      const page = await this.runRequest(conn, client, options, pick(`列出 ${serverId} 的工具`, `Listing tools of ${serverId}`), (signal) =>
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
      if (tools.length > MAX_TOOL_LIST_ITEMS) throw new Error(pick(`${serverId} 的工具超过 ${MAX_TOOL_LIST_ITEMS} 个，已停止读取`, `${serverId} has more than ${MAX_TOOL_LIST_ITEMS} tools. Stopped reading`))
      cursor = page.nextCursor
      if (cursor && seenCursors.has(cursor)) throw new Error(pick(`${serverId} 的工具列表翻页游标重复，已停止读取`, `The tool list cursor of ${serverId} repeats. Stopped reading`))
      if (cursor) seenCursors.add(cursor)
    } while (cursor)
    return tools
  }

  async readResource(serverId: string, uri: string, options: McpRequestOptions = {}): Promise<unknown> {
    this.assertRequestAllowed(options)
    const conn = this.require(serverId)
    await this.connect(conn)
    const client = conn.client
    if (!client) throw new McpConnectionCancelledError()
    return this.runRequest(conn, client, options, pick(`读取 ${serverId} 的资源 ${uri}`, `Reading resource ${uri} of ${serverId}`), (signal) =>
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
      const pin = options.connection ?? this.pinConnection(serverId)
      const takesControl = !WINDOWS_MCP_OBSERVE_TOOLS.has(toolName) && toolName !== WINDOWS_MCP_CONTROL_TOOL
      const releases = toolName === WINDOWS_MCP_CONTROL_TOOL && args.release === true
      if (takesControl) {
        this.activeInputCalls++
        this.clearIdleRelease()
      }
      try {
        return await sharedResources.run(INTERACTIVE_RESOURCE, `mcp:${serverId}`, async () => {
          this.assertPinCurrent(pin)
          const conn = this.require(serverId)
          await this.connect(conn)
          this.assertPinCurrent(pin)
          if (takesControl) this.computerControlHeld = true
          try {
            const result = await this.callToolUncoordinated(conn, serverId, toolName, args, options)
            if (releases && !(result as { isError?: unknown } | null)?.isError) {
              this.computerControlHeld = false
              this.releaseAfterInput = false
              this.clearIdleRelease()
            }
            return result
          } catch (error) {
            if (!WINDOWS_MCP_OBSERVE_TOOLS.has(toolName)) sharedResources.markUncertain(INTERACTIVE_RESOURCE)
            throw error
          } finally {
            if (takesControl && this.connections.get(serverId) === conn && pin?.epoch === this.computerEpoch) this.computerControlHeld = true
          }
        })
      } finally {
        if (takesControl) {
          this.activeInputCalls--
          if (this.activeInputCalls === 0 && this.releaseAfterInput) void this.releaseComputerControl()
          else this.scheduleIdleRelease()
          this.settleIdle()
        }
      }
    }
    return this.callToolUncoordinated(this.require(serverId), serverId, toolName, args, options)
  }

  private async callToolUncoordinated(
    conn: Connection,
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    options: McpRequestOptions = {}
  ): Promise<unknown> {
    this.assertRequestAllowed(options)
    await this.connect(conn)
    const client = conn.client
    if (!client) throw new McpConnectionCancelledError()
    const what = pick(`调用 ${serverId}/${toolName}`, `Calling ${serverId}/${toolName}`)
    if (!options.longRunning) {
      return this.runRequest(conn, client, options, what, (signal) =>
        client.callTool({ name: toolName, arguments: args }, undefined, { signal })
      )
    }
    const idleMs = options.timeoutMs ?? MCP_LONG_CALL_IDLE_TIMEOUT_MS
    return this.runRequest(conn, client, { ...options, timeoutMs: options.timeoutMs ?? Infinity }, what, (signal) =>
      client.callTool({ name: toolName, arguments: args }, undefined, {
        signal,
        timeout: idleMs,
        resetTimeoutOnProgress: true,
        maxTotalTimeout: Math.max(idleMs, MCP_LONG_CALL_TOTAL_TIMEOUT_MS),
        onprogress: () => undefined
      })
    )
  }

  private clearIdleRelease(): void {
    if (this.idleRelease) clearTimeout(this.idleRelease)
    this.idleRelease = undefined
  }

  private scheduleIdleRelease(): void {
    this.clearIdleRelease()
    if (this.activeInputCalls > 0 || !this.computerControlHeld) return
    this.idleRelease = setTimeout(() => {
      this.idleRelease = undefined
      void this.releaseComputerControl()
    }, this.computerIdleReleaseMs)
    this.idleRelease.unref?.()
  }

  static async releaseHeldComputerControl(except?: McpConnectionManager): Promise<void> {
    const holders = [...controlHolders].filter((manager) => manager !== except)
    await Promise.all(holders.map((manager) => manager.releaseComputerControl({ afterInput: true }).catch(() => 'failed' as const)))
  }

  async releaseComputerControl(options: { afterInput?: boolean } = {}): Promise<'skipped' | 'deferred' | 'released' | 'failed'> {
    if (options.afterInput && this.activeInputCalls > 0) {
      this.releaseAfterInput = true
      return 'deferred'
    }
    const conn = this.connections.get(WINDOWS_MCP_SERVER_ID)
    if (!conn) {
      this.computerControlHeld = false
      this.releaseAfterInput = false
      this.clearIdleRelease()
      return 'skipped'
    }
    return this.releaseControlOn(conn)
  }

  private async releaseThenDetach(conn: Connection): Promise<McpCloseOutcome> {
    await this.releaseControlOn(conn)
    return this.detachAndRelease(conn)
  }

  private async releaseControlOn(conn: Connection): Promise<'skipped' | 'released' | 'failed'> {
    if (conn.config.id !== WINDOWS_MCP_SERVER_ID) return 'skipped'
    this.releaseAfterInput = false
    if (!this.computerControlHeld) return 'skipped'
    this.computerControlHeld = false
    this.clearIdleRelease()
    const client = conn.client
    if (!client || conn.status !== 'ready') return 'skipped'
    let timer: NodeJS.Timeout | undefined
    try {
      const request = this.runRequest(conn, client, { timeoutMs: WINDOWS_MCP_RELEASE_TIMEOUT_MS }, `${WINDOWS_MCP_SERVER_ID}/${WINDOWS_MCP_CONTROL_TOOL}`, (signal) =>
        client.callTool({ name: WINDOWS_MCP_CONTROL_TOOL, arguments: { release: true } }, undefined, { signal })
      )
      request.catch(() => undefined)
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`release timed out (${WINDOWS_MCP_RELEASE_TIMEOUT_MS}ms)`)), WINDOWS_MCP_RELEASE_TIMEOUT_MS)
      })
      const result = await Promise.race([request, deadline])
      if ((result as { isError?: unknown } | null)?.isError) throw new Error(JSON.stringify((result as { content?: unknown }).content ?? null).slice(0, 300))
      return 'released'
    } catch (error) {
      console.warn('[computer-use] release desktop control failed:', error instanceof Error ? error.message : String(error))
      return 'failed'
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async closeConfirmed(): Promise<McpCloseOutcome> {
    this.clearIdleWaiters()
    await this.releaseComputerControl()
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
