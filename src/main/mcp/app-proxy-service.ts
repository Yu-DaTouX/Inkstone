import { readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { dirname, join, resolve, sep } from 'node:path'
import { CapabilityCommandError, type CapabilityCommandResult } from '../capability-server'
import { YAN_DIR } from '../paths'
import { loadMcpServersCached } from './config'
import { truncateUtf8 } from '../../shared/mcp'
import { isInkstoneManaged, type McpAppCsp, type McpAppServerConfig } from './app-spec'
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
export const MCP_APP_PROXY_NO_TARGETS = 'no_targets'
const SNAPSHOT_VERSION = 1
const SNAPSHOT_SOURCE = 'inkstone-mcp-app-proxy'

const MCP_APP_TOOL_NAME_MAX = 64

function normalizeMcpAppToolName(serverId: string, toolName: string): string {
  const name = `mcp__${serverId}__${toolName}`.replace(/[^A-Za-z0-9_]/g, '_')
  if (name.length <= MCP_APP_TOOL_NAME_MAX) return name
  const hash = createHash('sha256').update(`${serverId}\0${toolName}`).digest('hex').slice(0, 8)
  return `${name.slice(0, MCP_APP_TOOL_NAME_MAX - hash.length - 1)}_${hash}`
}

interface McpAppProxyTool {
  name: string
  serverId: string
  toolName: string
  projectScope?: string
  enabled?: boolean
  projectEnabled?: Record<string, boolean>
  description?: string
  inputSchema?: unknown
  annotations?: unknown
}

function toolAvailability(config: McpAppServerConfig): Pick<McpAppProxyTool, 'enabled' | 'projectEnabled'> {
  if (config.projectScope) return {}
  return {
    ...(config.enabled === false ? { enabled: false } : {}),
    ...(config.projectEnabled ? { projectEnabled: config.projectEnabled } : {})
  }
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
  reason: 'not-model-visible' | 'name-collision'
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
  arguments?: Record<string, unknown>
  result?: unknown
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
  toolsChangedVersions?(): ReadonlyMap<string, number>
  acknowledgeToolsChanged?(serverId: string, version: number): void
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

const snapshotWrites = new Map<string, Promise<unknown>>()

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
  private readonly ensuring = new Map<string, Promise<{ refreshed: boolean; error?: string }>>()
  private readonly ensureFailedAt = new Map<string, number>()
  private readonly refreshingChanges = new Map<string, { projectId?: string; task: Promise<void> }>()
  private readonly publishedRefresh = new Map<string, number>()
  private refreshSequence = 0

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
      needsRefresh: stale || (this.host.toolsChangedVersions?.().size ?? 0) > 0
    }
  }

  async refresh(options: {
    serverIds?: string[]
    callerProjectId?: string
    signal?: AbortSignal
    allowEmpty?: boolean
  } = {}): Promise<McpAppProxyRefreshResult> {
    const sequence = ++this.refreshSequence
    const configured = new Map(loadMcpServersCached(this.env).servers.map((server) => [server.id, server]))
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
    const acknowledged: Array<{ serverId: string; version: number }> = []

    for (const server of targets) {
      try {
        const changedVersion = this.host.toolsChangedVersions?.().get(server.id)
        const list = await this.host.listToolsWithMeta(server.id, {
          ...(callerProjectId ? { projectId: callerProjectId } : {}),
          ...(options.signal ? { signal: options.signal } : {})
        })
        const original = configured.get(server.id) ?? server
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
            ...toolAvailability(original),
            ...(tool.description ? { description: tool.description } : {}),
            ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
            ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {})
          })
          count += 1
        }
        if (changedVersion !== undefined) acknowledged.push({ serverId: server.id, version: changedVersion })
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
      const collided = new Set(collisions.map((entry) => entry.name))
      for (let index = tools.length - 1; index >= 0; index--) {
        const tool = tools[index]
        if (!collided.has(tool.name)) continue
        excluded.push({ serverId: tool.serverId, toolName: tool.toolName, reason: 'name-collision' })
        tools.splice(index, 1)
      }
      for (const server of servers) server.toolCount = tools.filter((tool) => tool.serverId === server.id).length
    }

    const replaced = new Set<string>()
    const removed = new Set<string>()
    const managedIds = new Set(managed.map((server) => server.id))
    const publishedAfter = (id: string) => (this.publishedRefresh.get(id) ?? 0) > sequence
    const written = await this.commitSnapshot((current) => {
      for (const server of requested ? servers : targets) {
        if (!publishedAfter(server.id)) replaced.add(server.id)
      }
      if (requested && !replaced.size) return null
      const keep = (id: string, scope?: string) => {
        if (replaced.has(id)) return false
        if (requested || managedIds.has(id) || publishedAfter(id) || (scope && scope !== callerProjectId)) return true
        const original = configured.get(id)
        if (original && isInkstoneManaged({ ...original, enabled: original.enabled !== false || Object.values(original.projectEnabled ?? {}).some(Boolean) })) return true
        removed.add(id)
        return false
      }
      const scopes = new Map(current?.tools.map((tool) => [tool.serverId, tool.projectScope]))
      const scopeOf = (id: string) => configured.get(id)?.projectScope ?? scopes.get(id)
      const keptTools = (current?.tools ?? []).filter((tool) => keep(tool.serverId, tool.projectScope)).map((tool) => {
        const original = configured.get(tool.serverId)
        if (requested || !original || publishedAfter(tool.serverId)) return tool
        const { enabled: _enabled, projectEnabled: _projectEnabled, ...entry } = tool
        return { ...entry, ...toolAvailability(original) }
      })
      const keptServers = (current?.servers ?? []).filter((server) => keep(server.id, scopeOf(server.id)))
      const keptExcluded = (current?.excluded ?? []).filter((item) => keep(item.serverId, scopeOf(item.serverId)))
      return {
        version: SNAPSHOT_VERSION,
        generatedAt: requested && current?.generatedAt ? current.generatedAt : generatedAt,
        source: SNAPSHOT_SOURCE,
        tools: [...keptTools, ...tools.filter((tool) => replaced.has(tool.serverId))],
        servers: [...keptServers, ...servers.filter((server) => replaced.has(server.id))],
        excluded: [...keptExcluded, ...excluded.filter((item) => replaced.has(item.serverId))]
      }
    }, () => {
      for (const id of replaced) this.publishedRefresh.set(id, sequence)
      for (const id of removed) this.publishedRefresh.set(id, sequence)
    })
    for (const entry of acknowledged) {
      if (replaced.has(entry.serverId)) this.host.acknowledgeToolsChanged?.(entry.serverId, entry.version)
    }
    return {
      ok: errors.length === 0,
      path: this.snapshotPath(),
      written,
      generatedAt,
      toolCount: tools.length,
      tools,
      servers,
      excluded,
      collisions,
      errors
    }
  }

  refreshChanged(serverId: string, callerProjectId?: string): Promise<void> {
    const existing = this.refreshingChanges.get(serverId)
    if (existing) {
      existing.projectId = callerProjectId
      return existing.task
    }
    const entry = { projectId: callerProjectId, task: Promise.resolve() }
    entry.task = Promise.resolve().then(async () => {
      try {
        let seen: number | undefined
        for (;;) {
          const version = this.host.toolsChangedVersions?.().get(serverId)
          if (version === undefined || version === seen) return
          seen = version
          const result = await this.refresh({ serverIds: [serverId], callerProjectId: entry.projectId })
          if (result.errors.length) throw new Error(result.errors[0].error)
        }
      } finally {
        this.refreshingChanges.delete(serverId)
      }
    })
    this.refreshingChanges.set(serverId, entry)
    return entry.task
  }

  toolsChangedServers(callerProjectId?: string): string[] {
    const changed = this.host.toolsChangedVersions?.()
    if (!changed || changed.size === 0) return []
    return this.host.listManagedServers(callerProjectId).map((server) => server.id).filter((id) => changed.has(id))
  }

  needsRefreshFor(callerProjectId?: string): boolean {
    const managed = this.host.listManagedServers(callerProjectId)
    const snapshot = this.readSnapshot()
    if (!snapshot) return managed.length > 0
    if (this.toolsChangedServers(callerProjectId).length > 0) return true
    const managedIds = new Set(managed.map((server) => server.id))
    const knownIds = new Set(snapshot.servers.map((server) => server.id))
    if (managed.some((server) => !knownIds.has(server.id))) return true
    const orphaned = snapshot.tools.some((tool) => {
      const scope = typeof tool.projectScope === 'string' ? tool.projectScope : ''
      const disabledHere = callerProjectId && Object.hasOwn(tool.projectEnabled ?? {}, callerProjectId)
        ? tool.projectEnabled?.[callerProjectId] === false : tool.enabled === false
      return !managedIds.has(tool.serverId) && !(scope && scope !== callerProjectId) && !disabledHere
    })
    if (orphaned) return true
    return this.snapshotStatus().stale && (managed.length > 0 || snapshot.tools.length > 0)
  }

  async ensureFresh(options: { callerProjectId?: string; waitMs?: number; retryAfterFailureMs?: number } = {}): Promise<{ refreshed: boolean; error?: string }> {
    const projectId = typeof options.callerProjectId === 'string' && options.callerProjectId.trim() ? options.callerProjectId.trim() : undefined
    const key = projectId ?? ''
    try {
      if (!this.needsRefreshFor(projectId)) return { refreshed: false }
    } catch (error) {
      return { refreshed: false, error: errorMessage(error) }
    }
    const failedAt = this.ensureFailedAt.get(key)
    if (failedAt !== undefined && Date.now() - failedAt < (options.retryAfterFailureMs ?? 60_000)) return { refreshed: false, error: 'recent-failure' }
    let task = this.ensuring.get(key)
    if (!task) {
      const started = this.refresh({ ...(projectId ? { callerProjectId: projectId } : {}), allowEmpty: true }).then(
        (result) => {
          if (result.ok) this.ensureFailedAt.delete(key)
          else this.ensureFailedAt.set(key, Date.now())
          return { refreshed: result.written, ...(result.ok ? {} : { error: result.errors.map((entry) => `${entry.serverId}: ${entry.error}`).join('\n') || result.error || 'refresh-failed' }) }
        },
        (error) => {
          this.ensureFailedAt.set(key, Date.now())
          return { refreshed: false, error: errorMessage(error) }
        }
      )
      task = started.finally(() => {
        if (this.ensuring.get(key) === task) this.ensuring.delete(key)
      })
      this.ensuring.set(key, task)
    }
    let timer: NodeJS.Timeout | undefined
    const wait = new Promise<{ refreshed: boolean; error?: string }>((resolve) => {
      timer = setTimeout(() => resolve({ refreshed: false, error: 'timeout' }), options.waitMs ?? 8000)
    })
    try {
      return await Promise.race([task, wait])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private commitSnapshot(build: (current: McpAppProxySnapshot | null) => McpAppProxySnapshot | null, onWritten: () => void): Promise<boolean> {
    const path = this.snapshotPath()
    const run = (snapshotWrites.get(path) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const snapshot = build(this.readSnapshot())
      if (!snapshot) return false
      await writeAtomicText(path, `${JSON.stringify(snapshot, null, 2)}\n`)
      onWritten()
      return true
    })
    snapshotWrites.set(path, run)
    return run
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
      structuredContent: outcome.structuredContent,
      arguments: input.args,
      result: Buffer.byteLength(JSON.stringify(outcome.result ?? {}), 'utf8') <= 1024 * 1024
        ? outcome.result
        : { content: [{ type: 'text', text }], isError: outcome.isError }
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
    if (snapshot?.excluded.some((item) => item.reason === 'not-model-visible' && item.serverId === input.serverId && item.toolName === input.toolName)) {
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
