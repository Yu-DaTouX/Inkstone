import { readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { dirname, join, resolve, sep } from 'node:path'
import { CapabilityCommandError, type CapabilityCommandResult } from '../capability-server'
import { YAN_DIR } from '../paths'
import { loadMcpServersCached } from './config'
import { truncateUtf8 } from '../../shared/mcp'
import type { McpAppCsp, McpAppServerConfig } from './app-spec'
import {
  McpAppUnmanagedError,
  mcpAppHost,
  type McpAppCallOutcome,
  type McpAppToolDescriptor
} from './app-host'

const MCP_APP_PROXY_TOOLS_ENV = 'YAN_MCP_APP_TOOLS'
export const MCP_APP_PROXY_PROJECT_ENV = 'YAN_MCP_APP_PROJECT_ID'
const MCP_APP_PROXY_DIRNAME = 'mcp-app'
const MCP_APP_PROXY_SNAPSHOT_FILE = 'tools.json'
const MCP_APP_PROXY_TEXT_MAX_BYTES = 32 * 1024
const MCP_APP_PROXY_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000
export const MCP_APP_PROXY_COLLISION = 'tool_name_collision'
export const MCP_APP_PROXY_NO_TARGETS = 'no_targets'
const SNAPSHOT_VERSION = 1
const SNAPSHOT_SOURCE = 'inkstone-mcp-app-proxy'

function normalizeMcpAppToolName(serverId: string, toolName: string): string {
  return `mcp__${normalizeSegment(serverId)}__${normalizeSegment(toolName)}`
}

function normalizeSegment(value: string): string {
  return String(value).replace(/-/g, '_')
}

interface McpAppProxyTool {
  name: string
  serverId: string
  toolName: string
  projectScope?: string
  description?: string
  inputSchema?: unknown
  annotations?: unknown
}

interface McpAppProxySnapshotServer {
  id: string
  title?: string
  toolCount: number
  status: string
  error?: string
}

interface McpAppProxySnapshotExcluded {
  serverId: string
  toolName: string
  reason: 'not-model-visible'
}

interface McpAppProxySnapshot {
  version: number
  generatedAt: string
  source: string
  tools: McpAppProxyTool[]
  servers: McpAppProxySnapshotServer[]
  excluded: McpAppProxySnapshotExcluded[]
}

interface McpAppProxyRefreshResult {
  ok: boolean
  path: string
  written: boolean
  generatedAt: string
  toolCount: number
  tools: McpAppProxyTool[]
  servers: McpAppProxySnapshotServer[]
  excluded: McpAppProxySnapshotExcluded[]
  collisions: Array<{ name: string; count: number }>
  errors: Array<{ serverId: string; error: string }>
  error?: string
}

interface McpAppProxySnapshotStatus {
  path: string
  present: boolean
  generatedAt: string | null
  ageMs: number | null
  stale: boolean
  needsRefresh: boolean
}

interface McpAppProxyOwner {
  sessionId: string
  projectId: string
  runnerId?: string
  epoch?: number
}

interface McpAppProxyCallRecord {
  callId: string
  owner: McpAppProxyOwner
  serverId: string
  toolName: string
  at: number
  ok: boolean
  isError: boolean
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

class McpAppProxyError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'McpAppProxyError'
  }
}

interface McpAppProxyHostLike {
  listManagedServers(projectId?: string): McpAppServerConfig[]
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

interface McpAppProxyServiceOptions {
  host?: McpAppProxyHostLike
  env?: NodeJS.ProcessEnv
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

function isSafeMcpAppCallId(callId: unknown): callId is string {
  return typeof callId === 'string' && /^[A-Za-z0-9._:/-]{1,200}$/.test(callId) && !callId.includes('..')
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
  private host: McpAppProxyHostLike
  private env: NodeJS.ProcessEnv
  private readonly dir: string
  private readonly maxTextBytes: number
  private readonly snapshotMaxAgeMs: number
  private readonly maxRecords: number
  private readonly records = new Map<string, McpAppProxyCallRecord>()

  constructor(options: McpAppProxyServiceOptions = {}) {
    this.host = options.host ?? mcpAppHost()
    this.env = options.env ?? process.env
    this.dir = options.dir ?? join(YAN_DIR, MCP_APP_PROXY_DIRNAME)
    this.maxTextBytes = options.maxTextBytes ?? MCP_APP_PROXY_TEXT_MAX_BYTES
    this.snapshotMaxAgeMs = options.snapshotMaxAgeMs ?? MCP_APP_PROXY_SNAPSHOT_MAX_AGE_MS
    this.maxRecords = options.maxRecords ?? 200
  }

  adopt(options: McpAppProxyServiceOptions): void {
    if (options.env) this.env = options.env
    if (options.host) this.host = options.host
  }

  snapshotPath(): string {
    return join(this.dir, MCP_APP_PROXY_SNAPSHOT_FILE)
  }

  resultsDir(): string {
    return join(this.dir, 'results')
  }

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

  async refresh(options: {
    serverIds?: string[]
    callerProjectId?: string
    signal?: AbortSignal
    allowEmpty?: boolean
  } = {}): Promise<McpAppProxyRefreshResult> {
    const managed = this.host.listManagedServers(options.callerProjectId)
    const callerProjectId =
      typeof options.callerProjectId === 'string' && options.callerProjectId.trim()
        ? options.callerProjectId.trim()
        : null
    const requested = Array.isArray(options.serverIds) ? new Set(options.serverIds) : null
    const targets = managed.filter((server) => {
      if (requested && !requested.has(server.id)) return false
      if (server.projectScope && server.projectScope !== callerProjectId) return false
      return true
    })
    const generatedAt = new Date().toISOString()

    if (targets.length === 0 && !options.allowEmpty) {
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

    const targetIds = new Set(targets.map((server) => server.id))
    const managedIds = new Set(managed.map((server) => server.id))
    const keptFromOtherScopes = (this.readSnapshot()?.tools ?? []).filter((tool) => {
      if (targetIds.has(tool.serverId)) return false
      const scope = typeof tool.projectScope === 'string' ? tool.projectScope : ''
      return managedIds.has(tool.serverId) || (!!scope && scope !== callerProjectId)
    })
    const keptServerIds = new Set(keptFromOtherScopes.map((tool) => tool.serverId))
    const keptServers = (this.readSnapshot()?.servers ?? []).filter((server) => keptServerIds.has(server.id) && !targetIds.has(server.id))
    const snapshot: McpAppProxySnapshot = {
      version: SNAPSHOT_VERSION,
      generatedAt,
      source: SNAPSHOT_SOURCE,
      tools: [...keptFromOtherScopes, ...tools],
      servers: [...keptServers, ...servers],
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

  registrableTools(): McpAppProxyTool[] {
    return this.readSnapshot()?.tools ?? []
  }

  managedConfigOrNull(serverId: string): McpAppServerConfig | null {
    const config = loadMcpServersCached(this.env).servers.find((server) => server.id === serverId)
    if (!config || config.ownedBy !== 'inkstone' || !config.appHost) return null
    return config
  }

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

  getCallResult(callId: string, owner: McpAppProxyOwner): McpAppProxyCallRecord | null {
    if (!isSafeOwner(owner) || !isSafeMcpAppCallId(callId)) return null
    const record = this.records.get(this.recordKey(owner, callId))
    return record ? cloneForRead(record) : null
  }

  async close(): Promise<void> {
    this.records.clear()
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
  }

  private wrapCallError(error: unknown, fallbackCode: string, signal?: AbortSignal): McpAppProxyError {
    if (error instanceof McpAppProxyError) return error
    if (error instanceof McpAppUnmanagedError) return new McpAppProxyError('not-managed', error.message)
    if (signal?.aborted === true || isAbortError(error)) {
      return new McpAppProxyError('cancelled', '调用已取消；宿主已向后端转发取消')
    }
    return new McpAppProxyError(fallbackCode, errorMessage(error))
  }

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

interface McpAppProxyCommandInput {
  command: string
  params: Record<string, unknown>
  owner: McpAppProxyOwner
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
  host?: McpAppProxyHostLike
}

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

export function mcpAppProxyService(options: McpAppProxyServiceOptions = {}): McpAppProxyService {
  if (!sharedService) {
    sharedService = new McpAppProxyService(options)
    return sharedService
  }
  sharedService.adopt(options)
  return sharedService
}

export async function closeMcpAppProxyService(): Promise<void> {
  const service = sharedService
  sharedService = undefined
  await service?.close()
}

export function mcpAppProxyToolsEnv(env: NodeJS.ProcessEnv = process.env): { [MCP_APP_PROXY_TOOLS_ENV]?: string } {
  const status = mcpAppProxyService({ env }).snapshotStatus()
  return status.present && !status.stale ? { [MCP_APP_PROXY_TOOLS_ENV]: status.path } : {}
}
