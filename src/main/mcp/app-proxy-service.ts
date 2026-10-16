/**
 * 托管 MCP 工具的**模型代理通道**宿主侧实现（设计 A2）。
 *
 * ── 它解决什么 ──
 *   由砚托管的 MCP 服务，pi 原生已经不再连接（`mcp.json` 里没有它）。模型要能
 *   调用它的工具，只能由砚宿主把「当前允许模型看的工具」做成一份**只读快照**，
 *   薄扩展（`resources/pi-extensions/mcp-app-proxy.js`）在工厂期读快照、按
 *   `mcp__<server>__<tool>` 注册代理工具；真正执行时再经**每个 runner 已有的**
 *   回环能力端点打回来，由本模块用 `McpAppHost` 的同一条连接调用。
 *
 * ── 不新开传输 ──
 *   通道就是 `capability-server.ts` 的 `127.0.0.1` + 每实例随机 Bearer token
 *   端点（新增 `mcp.app.call` 一条命令）。身份 (sessionId, projectId) 由端点绑定、
 *   逐一比对，模型不能自报放行；每次 `callId` 再与本模块记录的宿主 runner 身份绑定。
 *
 * ── 边界（缺省一律最严）──
 *   · 只登记 `modelVisible` 的工具；app-only 工具不进快照。
 *   · 快照只放工具名 / 描述 / schema / 注解，**不放**端点 token、命令、参数、
 *     环境变量、URL、凭证。
 *   · 快照只在显式 `refresh()`（用户刷新）时写；启动 / 渲染 / 恢复连接**不**触发连接。
 *   · `mcp.app.call` 每次重连服务端重查工具表：未知 / app-only 一律拒绝。
 *   · 取消 / 超时 / owner 失效明确失败；`AbortSignal` 一路透传到 SDK。
 *   · `structuredContent` / 原始 `_meta` 只留在宿主内存（供 A5/A6 按 `callId` 读），
 *     回给模型的只有 content 文本（32KB 上限，超限受控落盘）。
 */
import { readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { dirname, join, resolve, sep } from 'node:path'
import { CapabilityCommandError, type CapabilityCommandResult } from '../capability-server'
import { YAN_DIR } from '../paths'
import { loadMcpServers } from './config'
import { isInkstoneManaged, type McpAppCsp, type McpAppServerConfig } from './app-spec'
import {
  McpAppUnmanagedError,
  mcpAppHost,
  type McpAppCallOutcome,
  type McpAppToolDescriptor
} from './app-host'

/** 注入给 pi 子进程的快照路径（薄扩展工厂期同步读它）。 */
export const MCP_APP_PROXY_TOOLS_ENV = 'YAN_MCP_APP_TOOLS'
/** 注入给 pi 子进程的 runner 项目身份；薄扩展只注册「全局 + 本项目」的托管工具。 */
export const MCP_APP_PROXY_PROJECT_ENV = 'YAN_MCP_APP_PROJECT_ID'
/** 快照 / 落盘结果的隔离子目录（`<YAN_DIR>/mcp-app`）。 */
export const MCP_APP_PROXY_DIRNAME = 'mcp-app'
/** 快照文件名。 */
export const MCP_APP_PROXY_SNAPSHOT_FILE = 'tools.json'
/** 回给模型的 content 文本内联上限；超出写盘，不把整份内容塞进上下文。 */
export const MCP_APP_PROXY_TEXT_MAX_BYTES = 32 * 1024
/** 快照过期时间；过期即视为「待用户刷新」，不用旧表注册工具。 */
export const MCP_APP_PROXY_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000
/** 名字规范化后碰撞：整个快照拒绝，绝不静默覆盖。 */
export const MCP_APP_PROXY_COLLISION = 'tool_name_collision'
/** 本次刷新没有任何目标（显式空白名单，或没有当前项目可见的托管服务）。 */
export const MCP_APP_PROXY_NO_TARGETS = 'no_targets'
const SNAPSHOT_VERSION = 1
const SNAPSHOT_SOURCE = 'inkstone-mcp-app-proxy'

/** `mcp__<server>__<tool>`；`-` → `_`，与 pi 原生 MCP 命名同形。 */
export function normalizeMcpAppToolName(serverId: string, toolName: string): string {
  return `mcp__${normalizeSegment(serverId)}__${normalizeSegment(toolName)}`
}

function normalizeSegment(value: string): string {
  return String(value).replace(/-/g, '_')
}

/** 快照里的一条代理工具。 */
export interface McpAppProxyTool {
  /** 注册名 `mcp__<server>__<tool>`。 */
  name: string
  serverId: string
  toolName: string
  /** 服务声明的项目范围；缺省=全局。薄层据此只注册当前 runner 项目可用的工具。 */
  projectScope?: string
  description?: string
  inputSchema?: unknown
  annotations?: unknown
}

export interface McpAppProxySnapshotServer {
  id: string
  title?: string
  toolCount: number
  status: string
  error?: string
}

export interface McpAppProxySnapshotExcluded {
  serverId: string
  toolName: string
  reason: 'not-model-visible'
}

/** `YAN_DIR/mcp-app/tools.json` 的形状。不含 token / 配置 / 凭证。 */
export interface McpAppProxySnapshot {
  version: number
  generatedAt: string
  source: string
  tools: McpAppProxyTool[]
  servers: McpAppProxySnapshotServer[]
  excluded: McpAppProxySnapshotExcluded[]
}

export interface McpAppProxyRefreshResult {
  /** 是否无碰撞、无服务器错误。 */
  ok: boolean
  path: string
  /** 是否真的写出了快照（碰撞 / 全失败时为 false，旧快照不被半份数据覆盖）。 */
  written: boolean
  generatedAt: string
  toolCount: number
  tools: McpAppProxyTool[]
  servers: McpAppProxySnapshotServer[]
  excluded: McpAppProxySnapshotExcluded[]
  collisions: Array<{ name: string; count: number }>
  errors: Array<{ serverId: string; error: string }>
  /** 顶层失败码（目前只有碰撞）。 */
  error?: string
}

export interface McpAppProxySnapshotStatus {
  path: string
  present: boolean
  generatedAt: string | null
  ageMs: number | null
  stale: boolean
  needsRefresh: boolean
}

/** 宿主 runner 身份：由能力端点绑定值派生，不由请求自报。 */
export interface McpAppProxyOwner {
  sessionId: string
  projectId: string
  runnerId?: string
  epoch?: number
}

/** 一次调用的结构化记录（含原始 `_meta` / `structuredContent`，只给宿主）。 */
export interface McpAppProxyCallRecord {
  callId: string
  owner: McpAppProxyOwner
  serverId: string
  toolName: string
  at: number
  ok: boolean
  isError: boolean
  /** 回给模型的 content 文本（可能被 32KB 截断）。 */
  text: string
  textBytes: number
  truncated: boolean
  spilledPath?: string
  resourceUri: string | null
  uiCsp: McpAppCsp | null
  meta: Record<string, unknown> | null
  structuredContent: Record<string, unknown> | null
  error?: string
  code?: string
}

export class McpAppProxyError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'McpAppProxyError'
  }
}

/** 本模块需要的最小宿主能力（测试可注入假 host）。 */
export interface McpAppProxyHostLike {
  listManagedServers(): McpAppServerConfig[]
  listToolsWithMeta(
    serverId: string,
    options?: { signal?: AbortSignal; projectId?: string }
  ): Promise<McpAppToolDescriptor[]>
  callToolWithMeta(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    options?: { signal?: AbortSignal; projectId?: string }
  ): Promise<McpAppCallOutcome>
  statusOf(serverId: string): { status: string; error?: string }
}

export interface McpAppProxyServiceOptions {
  host?: McpAppProxyHostLike
  env?: NodeJS.ProcessEnv
  /** 覆盖 `YAN_DIR/mcp-app`（测试用隔离目录）。 */
  dir?: string
  maxTextBytes?: number
  snapshotMaxAgeMs?: number
  maxRecords?: number
}

function isSafeOwner(owner: unknown): owner is McpAppProxyOwner {
  if (!owner || typeof owner !== 'object') return false
  const o = owner as Record<string, unknown>
  return (
    typeof o.sessionId === 'string' &&
    o.sessionId.length > 0 &&
    o.sessionId.length <= 200 &&
    typeof o.projectId === 'string' &&
    o.projectId.length > 0 &&
    o.projectId.length <= 200
  )
}

/** `callId` 来自 pi，会进文件名；只接受窄字符集，拒绝路径穿越。 */
export function isSafeMcpAppCallId(callId: unknown): callId is string {
  return typeof callId === 'string' && /^[A-Za-z0-9._:/-]{1,200}$/.test(callId) && !callId.includes('..')
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 按 UTF-8 字符边界截断；返回完整字节数，便于如实回报。 */
export function truncateUtf8(text: string, maxBytes: number): { text: string; bytes: number; truncated: boolean } {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return { text, bytes: buffer.length, truncated: false }
  let end = maxBytes
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1
  return { text: buffer.subarray(0, end).toString('utf8'), bytes: buffer.length, truncated: true }
}

async function writeAtomicText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temp, text, { encoding: 'utf8', mode: 0o600 })
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

function cloneForRead<T>(value: T): T {
  try {
    return Object.freeze(structuredClone(value)) as T
  } catch {
    return value
  }
}

export class McpAppProxyService {
  private readonly host: McpAppProxyHostLike
  private readonly env: NodeJS.ProcessEnv
  private readonly dir: string
  private readonly maxTextBytes: number
  private readonly snapshotMaxAgeMs: number
  private readonly maxRecords: number
  private readonly records = new Map<string, McpAppProxyCallRecord>()
  private readonly listeners = new Set<(record: McpAppProxyCallRecord) => void>()

  constructor(options: McpAppProxyServiceOptions = {}) {
    this.host = options.host ?? mcpAppHost()
    this.env = options.env ?? process.env
    this.dir = options.dir ?? join(YAN_DIR, MCP_APP_PROXY_DIRNAME)
    this.maxTextBytes = options.maxTextBytes ?? MCP_APP_PROXY_TEXT_MAX_BYTES
    this.snapshotMaxAgeMs = options.snapshotMaxAgeMs ?? MCP_APP_PROXY_SNAPSHOT_MAX_AGE_MS
    this.maxRecords = options.maxRecords ?? 200
  }

  /** 快照文件路径（固定名；env 指向它）。 */
  snapshotPath(): string {
    return join(this.dir, MCP_APP_PROXY_SNAPSHOT_FILE)
  }

  /** 结果落盘目录（只在超限时写入 content 文本，不含 `_meta`）。 */
  resultsDir(): string {
    return join(this.dir, 'results')
  }

  /** 同步读快照；形状不对返回 null（宁可不注册，也不注册半份）。 */
  readSnapshot(): McpAppProxySnapshot | null {
    let text: string
    try {
      text = readFileSync(this.snapshotPath(), 'utf8')
    } catch {
      return null
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return null
    }
    const record = asRecord(parsed)
    if (!record || !Array.isArray(record.tools)) return null
    const tools = record.tools.filter((entry): entry is McpAppProxyTool => {
      const t = asRecord(entry)
      return Boolean(t && typeof t.name === 'string' && typeof t.serverId === 'string' && typeof t.toolName === 'string')
    })
    return {
      version: typeof record.version === 'number' ? record.version : SNAPSHOT_VERSION,
      generatedAt: typeof record.generatedAt === 'string' ? record.generatedAt : '',
      source: typeof record.source === 'string' ? record.source : SNAPSHOT_SOURCE,
      tools,
      servers: Array.isArray(record.servers) ? (record.servers.filter((s) => asRecord(s)) as McpAppProxySnapshotServer[]) : [],
      excluded: Array.isArray(record.excluded)
        ? (record.excluded.filter((e) => asRecord(e)) as McpAppProxySnapshotExcluded[])
        : []
    }
  }

  /** 快照新鲜度：缺失或超龄都算「待用户刷新」。 */
  snapshotStatus(): McpAppProxySnapshotStatus {
    const snapshot = this.readSnapshot()
    if (!snapshot) {
      return { path: this.snapshotPath(), present: false, generatedAt: null, ageMs: null, stale: true, needsRefresh: true }
    }
    const at = snapshot.generatedAt ? Date.parse(snapshot.generatedAt) : Number.NaN
    const ageMs = Number.isFinite(at) ? Date.now() - at : null
    const stale = ageMs === null || ageMs > this.snapshotMaxAgeMs
    return {
      path: this.snapshotPath(),
      present: true,
      generatedAt: snapshot.generatedAt || null,
      ageMs,
      stale,
      needsRefresh: stale
    }
  }

  /**
   * 可复用刷新接口：**只在这里**连接托管服务并重写快照。
   * 启动 / 渲染 / 恢复连接一律不调它（没有快照就老老实实等用户刷新）。
   *
   * ── caller 身份与目标范围（A6R）──
   *   · `callerProjectId` 必须是**可信调用方项目事实**（当前前台 runner 的 project）。
   *     它只用来筛「全局 + 本项目」目标，并原样透传给 `listToolsWithMeta`；
   *     绝不用目标自己的 `server.projectScope` 当 caller（否则项目服务会自证所属项目）。
   *   · 项目目标在 caller 缺失 / 不匹配时**一律不连**（fail-closed）；全局目标不受影响。
   *   · `serverIds` 为显式数组时是**目标白名单**：空数组 = 0 目标，绝不回退成全量；
   *     未传（undefined）才算「未指定」。
   *   · 0 目标时不写快照（避免用空表覆盖旧快照）。
   */
  async refresh(options: {
    serverIds?: string[]
    callerProjectId?: string
    signal?: AbortSignal
  } = {}): Promise<McpAppProxyRefreshResult> {
    const managed = this.host.listManagedServers()
    const callerProjectId =
      typeof options.callerProjectId === 'string' && options.callerProjectId.trim()
        ? options.callerProjectId.trim()
        : null
    const requested = Array.isArray(options.serverIds) ? new Set(options.serverIds) : null
    const targets = managed.filter((server) => {
      /* 显式白名单：空数组即 0 目标，绝不 `?.length` 当未指定。 */
      if (requested && !requested.has(server.id)) return false
      /* 目标可见性：全局始终可见；项目目标必须由可信 caller 匹配。 */
      if (server.projectScope && server.projectScope !== callerProjectId) return false
      return true
    })
    const generatedAt = new Date().toISOString()

    if (targets.length === 0) {
      return {
        ok: false,
        path: this.snapshotPath(),
        written: false,
        generatedAt,
        toolCount: 0,
        tools: [],
        servers: [],
        excluded: [],
        collisions: [],
        errors: [],
        error: MCP_APP_PROXY_NO_TARGETS
      }
    }

    const tools: McpAppProxyTool[] = []
    const servers: McpAppProxySnapshotServer[] = []
    const excluded: McpAppProxySnapshotExcluded[] = []
    const errors: Array<{ serverId: string; error: string }> = []

    for (const server of targets) {
      try {
        const list = await this.host.listToolsWithMeta(server.id, {
          /* 只传可信 caller 项目；服务自己的 projectScope 只用于上面的目标筛选。 */
          ...(callerProjectId ? { projectId: callerProjectId } : {}),
          ...(options.signal ? { signal: options.signal } : {})
        })
        let count = 0
        for (const tool of list) {
          if (!tool.modelVisible) {
            excluded.push({ serverId: server.id, toolName: tool.name, reason: 'not-model-visible' })
            continue
          }
          tools.push({
            name: normalizeMcpAppToolName(server.id, tool.name),
            serverId: server.id,
            toolName: tool.name,
            ...(server.projectScope ? { projectScope: server.projectScope } : {}),
            ...(tool.description ? { description: tool.description } : {}),
            ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
            ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {})
          })
          count += 1
        }
        const status = this.host.statusOf(server.id)
        servers.push({
          id: server.id,
          ...(server.title ? { title: server.title } : {}),
          toolCount: count,
          status: status.status,
          ...(status.error ? { error: status.error } : {})
        })
      } catch (error) {
        errors.push({ serverId: server.id, error: errorMessage(error) })
      }
    }

    /* 名字规范化碰撞：整个快照拒绝写出，旧快照不动。 */
    const counts = new Map<string, number>()
    for (const tool of tools) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1)
    const collisions = [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([name, count]) => ({ name, count }))
    if (collisions.length) {
      return {
        ok: false,
        path: this.snapshotPath(),
        written: false,
        generatedAt,
        toolCount: 0,
        tools: [],
        servers,
        excluded,
        collisions,
        errors,
        error: MCP_APP_PROXY_COLLISION
      }
    }

    const snapshot: McpAppProxySnapshot = {
      version: SNAPSHOT_VERSION,
      generatedAt,
      source: SNAPSHOT_SOURCE,
      tools,
      servers,
      excluded
    }
    await writeAtomicText(this.snapshotPath(), `${JSON.stringify(snapshot, null, 2)}\n`)
    return {
      ok: errors.length === 0,
      path: this.snapshotPath(),
      written: true,
      generatedAt,
      toolCount: tools.length,
      tools,
      servers,
      excluded,
      collisions,
      errors
    }
  }

  /** 按快照决定要注册给模型的工具（扩展侧同一份判断的宿主镜像，供诊断/测试）。 */
  registrableTools(): McpAppProxyTool[] {
    return this.readSnapshot()?.tools ?? []
  }

  /** 托管配置；不是托管项返回 null。 */
  managedConfigOrNull(serverId: string): McpAppServerConfig | null {
    const config = loadMcpServers(this.env).servers.find((server) => server.id === serverId)
    if (!config || !isInkstoneManaged(config)) return null
    return config
  }

  /**
   * 模型代理调用。
   *
   * 服务端**重查**：连接态工具表里必须有该工具、且 `modelVisible`，否则拒绝；
   * app-only 工具绝不能借这里绕过。原始 `_meta` / `structuredContent` 留在
   * 记录里，回给模型的只有 content 文本。
   */
  async call(input: {
    owner: McpAppProxyOwner
    callId: string
    serverId: string
    toolName: string
    args?: Record<string, unknown>
    signal?: AbortSignal
  }): Promise<McpAppProxyCallRecord> {
    if (!isSafeOwner(input.owner)) {
      throw new McpAppProxyError('owner_invalid', '缺少可用的宿主 runner 身份；拒绝代理调用')
    }
    if (!isSafeMcpAppCallId(input.callId)) {
      throw new McpAppProxyError('call_id_invalid', 'callId 形状不合法；拒绝代理调用')
    }
    const serverId = String(input.serverId ?? '').trim()
    const toolName = String(input.toolName ?? '').trim()
    if (!serverId || !toolName) throw new McpAppProxyError('arguments_invalid', '缺少 serverId 或 toolName')
    if (!this.managedConfigOrNull(serverId)) {
      throw new McpAppProxyError('not-managed', `MCP 服务 ${serverId} 未由砚托管，拒绝代理调用`)
    }
    const args = asRecord(input.args) ?? {}

    let tools: McpAppToolDescriptor[]
    try {
      tools = await this.host.listToolsWithMeta(serverId, {
        ...(input.owner.projectId ? { projectId: input.owner.projectId } : {}),
        ...(input.signal ? { signal: input.signal } : {})
      })
    } catch (error) {
      throw this.wrapCallError(error, 'tool_list_failed', input.signal)
    }
    const tool = tools.find((entry) => entry.name === toolName)
    if (!tool) {
      throw new McpAppProxyError('mcp_app_unknown_tool', `托管服务 ${serverId} 当前工具表里没有 ${toolName}`)
    }
    if (!tool.modelVisible) {
      throw new McpAppProxyError('mcp_app_only_tool', `工具 ${serverId}/${toolName} 仅对 App 视图可见；模型不能调用`)
    }

    let outcome: McpAppCallOutcome
    try {
      outcome = await this.host.callToolWithMeta(serverId, toolName, args, {
        ...(input.owner.projectId ? { projectId: input.owner.projectId } : {}),
        ...(input.signal ? { signal: input.signal } : {})
      })
    } catch (error) {
      throw this.wrapCallError(error, 'call_failed', input.signal)
    }

    const truncated = truncateUtf8(outcome.text, this.maxTextBytes)
    let spilledPath: string | undefined
    if (truncated.truncated) {
      spilledPath = await this.spillText(input.callId, outcome.text)
    }
    const text = truncated.truncated
      ? `${truncated.text}\n\n[输出 ${truncated.bytes} 字节，超过 ${this.maxTextBytes} 字节内联上限；完整 content 已受控落盘${spilledPath ? `：${spilledPath}` : '（落盘失败，未返回更多内容）'}]`
      : truncated.text

    const record: McpAppProxyCallRecord = {
      callId: input.callId,
      owner: input.owner,
      serverId,
      toolName,
      at: Date.now(),
      ok: true,
      isError: outcome.isError,
      text,
      textBytes: truncated.bytes,
      truncated: truncated.truncated,
      ...(spilledPath ? { spilledPath } : {}),
      resourceUri: outcome.resourceUri,
      uiCsp: outcome.uiCsp,
      meta: outcome.meta,
      structuredContent: outcome.structuredContent
    }
    this.remember(record)
    return record
  }

  /** 按 `callId` 只读取回结构化结果；宿主 runner 身份不符返回 null。 */
  getCallResult(callId: string, owner: McpAppProxyOwner): McpAppProxyCallRecord | null {
    if (!isSafeOwner(owner) || !isSafeMcpAppCallId(callId)) return null
    const record = this.records.get(this.recordKey(owner, callId))
    return record ? cloneForRead(record) : null
  }

  /** 订阅每次调用的结构化结果（A5/A6 视图接入用）。返回退订函数。 */
  onCallResult(listener: (record: McpAppProxyCallRecord) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async close(): Promise<void> {
    this.records.clear()
    this.listeners.clear()
  }

  private recordKey(owner: McpAppProxyOwner, callId: string): string {
    return `${owner.sessionId}\u0000${owner.projectId}\u0000${callId}`
  }

  private remember(record: McpAppProxyCallRecord): void {
    this.records.set(this.recordKey(record.owner, record.callId), record)
    while (this.records.size > this.maxRecords) {
      const oldest = this.records.keys().next().value
      if (oldest === undefined) break
      this.records.delete(oldest)
    }
    for (const listener of this.listeners) {
      try {
        listener(cloneForRead(record))
      } catch {
        /* 监听器出错不影响调用本身 */
      }
    }
  }

  private wrapCallError(error: unknown, fallbackCode: string, signal?: AbortSignal): McpAppProxyError {
    if (error instanceof McpAppProxyError) return error
    if (error instanceof McpAppUnmanagedError) return new McpAppProxyError('not-managed', error.message)
    if (signal?.aborted === true || isAbortError(error)) {
      return new McpAppProxyError('cancelled', '调用已取消；宿主已向后端转发取消')
    }
    return new McpAppProxyError(fallbackCode, errorMessage(error))
  }

  /** 受控落盘：只写 content 文本，路径必须在 results 目录内。 */
  private async spillText(callId: string, text: string): Promise<string | undefined> {
    if (!isSafeMcpAppCallId(callId)) return undefined
    const dir = resolve(this.resultsDir())
    const target = resolve(join(dir, `${callId.replace(/[:/]/g, '_')}.txt`))
    if (target !== dir && !target.startsWith(`${dir}${sep}`)) return undefined
    try {
      await mkdir(dir, { recursive: true })
      await writeAtomicText(target, text)
      return target
    } catch {
      return undefined
    }
  }
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const name = (error as { name?: unknown }).name
  const code = (error as { code?: unknown }).code
  return name === 'AbortError' || code === 'ABORT_ERR' || code === '20'
}

/* ------------------------------------------------------------------ */
/* 能力命令 / 单例 / 刷新入口                                          */
/* ------------------------------------------------------------------ */

export interface McpAppProxyCommandInput {
  command: string
  params: Record<string, unknown>
  owner: McpAppProxyOwner
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
  host?: McpAppProxyHostLike
}

/**
 * `mcp.app.call` 的能力端点实现。
 *
 * 回给模型的只有 `summary.text`；`_meta` / `structuredContent` 已由服务记在宿主侧。
 * 任何失败都如实抛出 `CapabilityCommandError`，**绝不**伪装成成功。
 */
export async function runMcpAppProxyCommand(input: McpAppProxyCommandInput): Promise<CapabilityCommandResult> {
  if (input.command !== 'call') {
    throw new CapabilityCommandError('unknown_command', `mcp.app.${input.command} 未实现`)
  }
  const callId = typeof input.params.callId === 'string' ? input.params.callId : ''
  const serverId = typeof input.params.serverId === 'string' ? input.params.serverId : ''
  const toolName = typeof input.params.toolName === 'string' ? input.params.toolName : ''
  const args = asRecord(input.params.arguments) ?? {}
  const service = mcpAppProxyService({ env: input.env, host: input.host })
  let record: McpAppProxyCallRecord
  try {
    record = await service.call({ owner: input.owner, callId, serverId, toolName, args, signal: input.signal })
  } catch (error) {
    if (error instanceof McpAppProxyError) throw new CapabilityCommandError(error.code, error.message)
    throw error
  }
  return {
    summary: {
      kind: 'mcp-app-call',
      callId,
      serverId,
      toolName,
      ok: true,
      isError: record.isError,
      text: record.text,
      textBytes: record.textBytes,
      truncated: record.truncated,
      ...(record.spilledPath ? { resultFile: record.spilledPath } : {})
    }
  }
}

/**
 * 旧入口 `yan mcp call` / `yan mcp describe` 的托管拦截（fail closed）。
 *
 * 托管服务由 `McpAppHost` 单例唯一持有连接；旧入口的连接管理器再连一次就是
 * **第二个持有者** —— 归属切换、审批、审计都会分叉。所以 `ownedBy:'inkstone'`
 * 的服务，两个动作一律拒绝并指回代理通道（`mcp.app.call` / `mcp__…` 工具），
 * 不给「模型可见就放行 legacy」的缝（那正是第一版漏掉的：describe 仍走旧连接）。
 * 非托管服务保持原样；同步、不建连接。
 */
export function assertLegacyMcpAccessBlocked(input: {
  env?: NodeJS.ProcessEnv
  serverId: string
  toolName?: string
  action?: 'call' | 'describe'
}): void {
  const service = mcpAppProxyService({ env: input.env })
  if (!service.managedConfigOrNull(input.serverId)) return
  const route = input.action === 'describe' ? 'yan mcp describe' : 'yan mcp call'
  if (input.toolName) {
    const snapshot = service.readSnapshot()
    if (snapshot?.excluded.some((item) => item.serverId === input.serverId && item.toolName === input.toolName)) {
      throw new CapabilityCommandError(
        'mcp_app_only_tool',
        `工具 ${input.serverId}/${input.toolName} 仅对 App 视图可见；模型不能调用。`
      )
    }
  }
  throw new CapabilityCommandError(
    'mcp_app_use_proxy',
    `MCP 服务 ${input.serverId} 由砚托管；${route} 不建第二条连接，请改用托管代理工具（mcp__…）。`
  )
}

let sharedService: McpAppProxyService | undefined

/** 进程级单例：主进程、能力端点与设置刷新共用同一份缓存。 */
export function mcpAppProxyService(options: McpAppProxyServiceOptions = {}): McpAppProxyService {
  if (!sharedService) sharedService = new McpAppProxyService(options)
  return sharedService
}

/** 测试 / 关闭：丢弃单例。 */
export async function closeMcpAppProxyService(): Promise<void> {
  const service = sharedService
  sharedService = undefined
  await service?.close()
}

/** 可复用刷新入口（A3/A4 / 设置页刷新按钮接它）。 */
export async function refreshMcpAppTools(options: {
  env?: NodeJS.ProcessEnv
  host?: McpAppProxyHostLike
  serverIds?: string[]
  callerProjectId?: string
  signal?: AbortSignal
} = {}): Promise<McpAppProxyRefreshResult> {
  return mcpAppProxyService({ env: options.env, host: options.host }).refresh({
    ...(options.serverIds ? { serverIds: options.serverIds } : {}),
    ...(options.callerProjectId ? { callerProjectId: options.callerProjectId } : {}),
    ...(options.signal ? { signal: options.signal } : {})
  })
}

/**
 * 给 pi 子进程的快照环境：只有「存在且未过期」才注入路径；
 * 否则返回空对象，薄扩展不注册任何托管工具（明确待用户刷新，不默认连接服务器）。
 */
export function mcpAppProxyToolsEnv(env: NodeJS.ProcessEnv = process.env): { [MCP_APP_PROXY_TOOLS_ENV]?: string } {
  const status = mcpAppProxyService({ env }).snapshotStatus()
  return status.present && !status.stale ? { [MCP_APP_PROXY_TOOLS_ENV]: status.path } : {}
}
