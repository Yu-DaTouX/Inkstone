import { createHash } from 'node:crypto'
import type { PermissionMode } from '../../shared/approval'
import type {
  McpAppViewApi,
  McpAppViewAuditEntry,
  McpAppViewDescriptor,
  McpAppViewRefreshResult,
  McpAppViewSnapshot
} from '../../shared/mcp-app-view'
import { isCompleteMcpAppOwner, type McpAppOwner } from '../../shared/mcp-app-preview'
import { truncateUtf8 } from '../../shared/mcp'
import { approveAppViewCall, type AppViewAsk } from './app-view-approval'
import {
  buildMcpAppHostContext,
  resolveMcpAppThemePreference,
  MCP_APP_DEFAULT_THEME,
  type McpAppTheme
} from './app-theme'
import { mcpServerIdentityFingerprint, type HostTrustGrant } from './app-view-trust'
import type { McpAppViewAuditStore } from './app-view-audit'
import { mcpAppVisibilityOf, MCP_APP_METHODS, type McpAppVisibility } from './app-spec'
import {
  McpAppResourceStore,
  type McpAppOwnerGuard,
  type McpAppResourceFetch
} from './app-resource-store'
import type { McpAppCallOutcome, McpAppResource, McpAppToolDescriptor } from './app-host'

export interface McpAppViewCallRecordLike {
  callId: string
  owner: { sessionId: string; projectId: string; runnerId?: string; epoch?: number }
  serverId: string
  toolName: string
  text: string
  resourceUri: string | null
}

export interface McpAppViewProxyLike {
  getCallResult(callId: string, owner: { sessionId: string; projectId: string; runnerId?: string; epoch?: number }): McpAppViewCallRecordLike | null
  snapshotStatus(): { present: boolean; stale: boolean; needsRefresh: boolean }
  registrableTools(): Array<{ serverId?: string; projectScope?: string }>
  refresh(options?: {
    serverIds?: string[]
    callerProjectId?: string
    signal?: AbortSignal
  }): Promise<{ ok: boolean; toolCount: number; error?: string }>
}

export interface McpAppViewHostLike {
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
  readResource(
    serverId: string,
    uri: string,
    options?: { signal?: AbortSignal; projectId?: string }
  ): Promise<McpAppResource>
}

export interface McpAppViewRunnerFacts {
  sessionId: string
  sessionFile: string
  projectId: string
  runnerId: string
  generation: number
  cwd: string
  title?: string
}

export interface McpAppViewRuntimeResolver {
  resolve(input: { callId: string }): Promise<McpAppViewRunnerFacts | null>
  currentProject?(): Promise<string | null>
}

export interface McpAppViewFactsSource {
  current(callId: string): McpAppViewRunnerFacts | null | Promise<McpAppViewRunnerFacts | null>
  isActive(owner: McpAppOwner): boolean
  currentProject?(): string | null | Promise<string | null>
}

export function createMcpAppViewRuntime(source: McpAppViewFactsSource): {
  runtime: McpAppViewRuntimeResolver
  ownerGuard: McpAppOwnerGuard
} {
  return {
    runtime: {
      async resolve({ callId }: { callId: string }): Promise<McpAppViewRunnerFacts | null> {
        try {
          const facts = await source.current(callId)
          return isFacts(facts) ? facts : null
        } catch {
          return null
        }
      },
      ...(source.currentProject
        ? {
            async currentProject(): Promise<string | null> {
              try {
                const projectId = await source.currentProject!()
                return typeof projectId === 'string' && projectId.trim() ? projectId.trim() : null
              } catch {
                return null
              }
            }
          }
        : {})
    },
    ownerGuard: {
      isActive(owner: McpAppOwner): boolean {
        try {
          return source.isActive(owner) === true
        } catch {
          return false
        }
      }
    }
  }
}

export interface McpAppViewServiceOptions {
  proxy: McpAppViewProxyLike
  host: McpAppViewHostLike
  ownerGuard: McpAppOwnerGuard
  runtime: McpAppViewRuntimeResolver
  ask: AppViewAsk
  audit: McpAppViewAuditStore
  serverConfigOf(serverId: string): unknown | null
  permissionMode?(): PermissionMode | Promise<PermissionMode>
  grantsOf?(
    facts: McpAppViewRunnerFacts,
    serverId: string
  ): Promise<readonly HostTrustGrant[]> | readonly HostTrustGrant[]
  fetchResource?: McpAppResourceFetch
  store?: McpAppResourceStore
  hostContext?(): Record<string, unknown> | Promise<Record<string, unknown>>
  theme?(): McpAppTheme | string | null | undefined | Promise<McpAppTheme | string | null | undefined>
  systemPrefersDark?(): boolean
  now?(): number
  maxMessageBytes?: number
  maxConcurrentCallsPerInstance?: number
  maxSeenIdsPerInstance?: number
  maxInstances?: number
  maxCallSessions?: number
}

interface InstanceBinding {
  instanceId: string
  url: string
  owner: McpAppOwner
  facts: McpAppViewRunnerFacts
  callId: string
  serverId: string
  resourceUri: string
  title: string
  initialized: boolean
  abort: AbortController
  seenIds: Set<string>
  inFlight: number
}

const DEFAULT_MESSAGE_MAX_BYTES = 1024 * 1024
const DEFAULT_MAX_CONCURRENT = 4
const DEFAULT_MAX_SEEN_IDS = 512
const DEFAULT_MAX_INSTANCES = 8
const DEFAULT_MAX_CALL_SESSIONS = 512
const APP_RESULT_TEXT_MAX_BYTES = 32 * 1024

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== '__proto__')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
}

export function hashMcpAppViewArgs(args: unknown): string {
  return createHash('sha256').update(stableStringify(args ?? {})).digest('hex')
}

function matchesJsonType(type: string, value: unknown): boolean {
  switch (type) {
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    case 'array':
      return Array.isArray(value)
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    default:
      return true
  }
}

function validateToolArgs(schema: unknown, args: Record<string, unknown>): string | null {
  const shape = asRecord(schema)
  if (!shape) return null
  if (Array.isArray(shape.required)) {
    for (const key of shape.required) {
      if (typeof key === 'string' && !Object.prototype.hasOwnProperty.call(args, key)) return `缺少必填参数：${key}`
    }
  }
  const props = asRecord(shape.properties)
  if (!props) return null
  for (const [key, definition] of Object.entries(props)) {
    if (!Object.prototype.hasOwnProperty.call(args, key)) continue
    const def = asRecord(definition)
    if (!def) continue
    if (typeof def.type === 'string' && !matchesJsonType(def.type, args[key])) {
      return `参数 ${key} 的类型与工具 schema 不符`
    }
  }
  return null
}

function limitResultContent(result: unknown): unknown {
  const record = asRecord(result)
  if (!record || !Array.isArray(record.content)) return result
  let limited = false
  const content = record.content.map((item) => {
    const entry = asRecord(item)
    if (!entry || typeof entry.text !== 'string') return item
    const truncated = truncateUtf8(entry.text, APP_RESULT_TEXT_MAX_BYTES)
    if (!truncated.truncated) return item
    limited = true
    return {
      ...entry,
      text: `${truncated.text}\n\n[结果 ${truncated.bytes} 字节，超过 ${APP_RESULT_TEXT_MAX_BYTES} 字节上限，已截断]`
    }
  })
  return limited ? { ...record, content } : result
}

function isFacts(value: unknown): value is McpAppViewRunnerFacts {
  const facts = asRecord(value)
  if (!facts) return false
  for (const key of ['sessionId', 'sessionFile', 'projectId', 'runnerId', 'cwd']) {
    const item = facts[key]
    if (typeof item !== 'string' || !item.trim()) return false
  }
  return typeof facts.generation === 'number' && Number.isFinite(facts.generation) && facts.generation >= 0
}

function isVisibleToProject(projectScope: string | undefined | null, callerProjectId: string | null): boolean {
  if (!projectScope) return true
  return callerProjectId !== null && projectScope === callerProjectId
}

interface ParsedRpcOk {
  ok: true
  id: string | number | undefined
  method: string
  params: Record<string, unknown>
}

interface ParsedRpcError {
  ok: false
  id: unknown
  error: string
}

export class McpAppViewService implements McpAppViewApi {
  private readonly proxy: McpAppViewProxyLike
  private readonly host: McpAppViewHostLike
  private readonly ownerGuard: McpAppOwnerGuard
  private readonly runtime: McpAppViewRuntimeResolver
  private readonly ask: AppViewAsk
  private readonly auditStore: McpAppViewAuditStore
  private readonly serverConfigOf: (serverId: string) => unknown | null
  private readonly permissionMode: () => PermissionMode | Promise<PermissionMode>
  private readonly grantsOf: (
    facts: McpAppViewRunnerFacts,
    serverId: string
  ) => Promise<readonly HostTrustGrant[]> | readonly HostTrustGrant[]
  private readonly hostContextProvider: () => Record<string, unknown> | Promise<Record<string, unknown>>
  private readonly theme: McpAppViewServiceOptions['theme']
  private readonly systemPrefersDark?: () => boolean
  private readonly now: () => number
  private readonly store: McpAppResourceStore
  private readonly maxMessageBytes: number
  private readonly maxConcurrent: number
  private readonly maxSeenIds: number
  private readonly maxInstances: number
  private readonly maxCallSessions: number
  private readonly instances = new Map<string, InstanceBinding>()
  private readonly callSessions = new Map<string, string>()

  constructor(options: McpAppViewServiceOptions) {
    this.proxy = options.proxy
    this.host = options.host
    if (!options.ownerGuard || typeof options.ownerGuard.isActive !== 'function') {
      throw new Error('McpAppViewService requires an ownerGuard; refusing to construct a fail-open service')
    }
    this.ownerGuard = options.ownerGuard
    this.runtime = options.runtime
    this.ask = options.ask
    this.auditStore = options.audit
    this.serverConfigOf = options.serverConfigOf
    this.permissionMode = options.permissionMode ?? (() => 'danger')
    this.grantsOf = options.grantsOf ?? (() => [])
    this.hostContextProvider = options.hostContext ?? (() => ({}))
    this.theme = options.theme
    this.systemPrefersDark = options.systemPrefersDark
    this.now = options.now ?? Date.now
    if (options.store) {
      this.store = options.store
    } else if (options.fetchResource) {
      this.store = new McpAppResourceStore({ ownerGuard: this.ownerGuard, fetchResource: options.fetchResource })
    } else {
      throw new Error('McpAppViewService requires fetchResource or a pre-built store; refusing to construct')
    }
    this.maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MESSAGE_MAX_BYTES
    this.maxConcurrent = options.maxConcurrentCallsPerInstance ?? DEFAULT_MAX_CONCURRENT
    this.maxSeenIds = options.maxSeenIdsPerInstance ?? DEFAULT_MAX_SEEN_IDS
    this.maxInstances = options.maxInstances ?? DEFAULT_MAX_INSTANCES
    this.maxCallSessions = options.maxCallSessions ?? DEFAULT_MAX_CALL_SESSIONS
  }

  resourceStore(): McpAppResourceStore {
    return this.store
  }

  async hostContext(instanceId: string): Promise<unknown | null> {
    const binding = this.instances.get(String(instanceId ?? ''))
    if (!binding) return null
    if (!this.isOwnerActive(binding.owner)) return null
    try {
      return await this.resolveHostContext()
    } catch {
      return null
    }
  }

  async prepare(callId: string): Promise<McpAppViewDescriptor> {
    const id = typeof callId === 'string' ? callId.trim() : ''
    if (!id || id.length > 200) return { kind: 'error', error: '缺少有效的工具调用 ID' }
    const facts = await this.resolveFacts(id)
    if (!facts) return { kind: 'error', error: '当前没有可用的前台运行实例，或该调用不属于当前会话' }

    let record: McpAppViewCallRecordLike | null
    try {
      record = this.proxy.getCallResult(id, {
        sessionId: facts.sessionId,
        projectId: facts.projectId,
        runnerId: facts.runnerId,
        epoch: facts.generation
      })
    } catch {
      record = null
    }
    if (!record) {
      return { kind: 'text', text: '', reason: '没有本机的工具调用结果；App 视图不恢复，也不会重跑工具' }
    }
    if (record.owner.sessionId !== facts.sessionId || record.owner.projectId !== facts.projectId) {
      return { kind: 'error', error: '工具调用记录不属于当前会话，拒绝准备 App 视图' }
    }
    if (record.owner.runnerId && record.owner.runnerId !== facts.runnerId) {
      return { kind: 'error', error: '工具调用记录不属于当前运行实例，拒绝准备 App 视图' }
    }
    if (typeof record.owner.epoch === 'number' && record.owner.epoch !== facts.generation) {
      return { kind: 'error', error: '工具调用记录来自旧运行代次，拒绝准备 App 视图' }
    }

    const serverId = String(record.serverId ?? '').trim()
    const toolName = String(record.toolName ?? '').trim()
    if (!serverId || !toolName) return { kind: 'error', error: '工具调用记录缺少服务或工具信息' }

    const resourceUri = await this.resolveResourceUri(record, facts)
    if (!resourceUri) {
      return { kind: 'text', text: typeof record.text === 'string' ? record.text : '', reason: '该工具结果没有可渲染的 App 资源' }
    }

    const owner: McpAppOwner = {
      serverId,
      sessionId: facts.sessionId,
      sessionFile: facts.sessionFile,
      projectId: facts.projectId,
      runnerId: facts.runnerId,
      generation: facts.generation,
      toolCallId: id
    }
    if (!isCompleteMcpAppOwner(owner)) return { kind: 'error', error: '实例归属信息不完整，拒绝准备 App 视图' }
    if (this.instances.size >= this.maxInstances) {
      return { kind: 'error', error: 'App 视图实例数已达上限，请先关闭其它视图' }
    }

    let prepared: Awaited<ReturnType<McpAppResourceStore['prepare']>>
    try {
      prepared = await this.store.prepare({ serverId, resourceUri, owner })
    } catch {
      return { kind: 'text', text: record.text ?? '', reason: 'App 资源读取失败' }
    }
    if (!prepared.ok) {
      if (prepared.error === 'owner' || prepared.error === 'revoked' || prepared.error === 'input') {
        return { kind: 'error', error: `拒绝准备 App 视图（${prepared.error}）` }
      }
      return { kind: 'text', text: record.text ?? '', reason: `App 视图不可用（${prepared.error}）` }
    }

    const title = (facts.title ?? '').trim() || serverId
    const binding: InstanceBinding = {
      instanceId: prepared.instanceId,
      url: prepared.url,
      owner,
      facts,
      callId: id,
      serverId,
      resourceUri,
      title,
      initialized: false,
      abort: new AbortController(),
      seenIds: new Set(),
      inFlight: 0
    }
    this.instances.set(prepared.instanceId, binding)
    this.rememberCallSession(id, facts.sessionFile)
    return { kind: 'ready', instanceId: prepared.instanceId, url: prepared.url, title, callId: id }
  }

  async dispatch(instanceId: string, message: unknown): Promise<unknown> {
    const binding = this.instances.get(String(instanceId ?? ''))
    if (!binding) return this.rpcError(null, -32600, 'App 实例不存在或已释放')

    const parsed = this.parseRpc(message)
    if (!parsed.ok) return this.rpcError(parsed.id, -32600, parsed.error)
    const { id, method, params } = parsed

    if (id !== undefined && !this.rememberId(binding, id)) {
      return this.rpcError(id, -32600, '重复的请求 ID，拒绝重放')
    }
    if (!this.isOwnerActive(binding.owner)) {
      return this.rpcError(id, -32001, 'App 实例归属已失效，拒绝请求')
    }

    switch (method) {
      case MCP_APP_METHODS.initialize:
        binding.initialized = true
        return this.rpcResult(id, { hostContext: await this.resolveHostContext() })
      case MCP_APP_METHODS.initialized:
        if (!binding.initialized) {
          return this.rpcError(id, -32002, 'App 尚未成功初始化，拒绝 initialized 通知')
        }
        return null
      case MCP_APP_METHODS.sizeChanged:
        return null
      case MCP_APP_METHODS.requestDisplayMode:
        return this.rpcResult(id, { displayMode: 'inline' })
      case MCP_APP_METHODS.toolsCall:
        if (id === undefined) return this.rpcError(null, -32600, 'tools/call 必须是带 id 的请求')
        if (!binding.initialized) return this.rpcError(id, -32002, 'App 尚未完成初始化，拒绝调用工具')
        return this.handleToolsCall(binding, id, params)
      case MCP_APP_METHODS.resourcesRead:
        if (id === undefined) return this.rpcError(null, -32600, 'resources/read 必须是带 id 的请求')
        return this.handleResourcesRead(binding, id, params)
      default:
        return this.rpcError(
          id,
          -32601,
          `不支持的 App 请求：${method}（首版只开放初始化、尺寸/显示通知与 tools/call）`
        )
    }
  }

  async release(instanceId: string): Promise<{ ok: boolean }> {
    const id = String(instanceId ?? '')
    const binding = this.instances.get(id)
    if (!binding) return { ok: false }
    this.instances.delete(id)
    this.abortBinding(binding)
    this.store.release(binding.instanceId, binding.owner)
    return { ok: true }
  }

  async audit(callId: string): Promise<McpAppViewAuditEntry[]> {
    const id = typeof callId === 'string' ? callId.trim() : ''
    if (!id) return []
    const facts = await this.resolveFacts(id)
    if (!facts) return []
    const known = this.callSessions.get(id)
    if (known && known !== facts.sessionFile) return []
    return this.auditStore.read(facts.sessionFile, id)
  }

  async snapshot(): Promise<McpAppViewSnapshot> {
    let needsRefresh = true
    let toolCount = 0
    try {
      const callerProjectId = await this.currentProjectId()
      const status = this.proxy.snapshotStatus()
      needsRefresh = status.needsRefresh
      toolCount = this.proxy
        .registrableTools()
        .filter((tool) => isVisibleToProject(tool.projectScope, callerProjectId)).length
    } catch {
    }
    return { needsRefresh, toolCount }
  }

  async refresh(): Promise<McpAppViewRefreshResult> {
    try {
      const callerProjectId = await this.currentProjectId()
      const result = await this.proxy.refresh(callerProjectId ? { callerProjectId } : {})
      return { ok: result.ok, toolCount: result.toolCount, ...(result.error ? { error: result.error } : {}) }
    } catch (error) {
      return { ok: false, toolCount: 0, error: messageOf(error) }
    }
  }

  invalidateSession(sessionId: string): number {
    const id = String(sessionId ?? '')
    let removed = 0
    for (const [instanceId, binding] of this.instances) {
      if (binding.owner.sessionId === id) {
        this.instances.delete(instanceId)
        this.abortBinding(binding)
        removed++
      }
    }
    try {
      this.store.invalidateSession(id)
    } catch {
    }
    return removed
  }

  invalidateRunner(serverId: string, runnerId: string): number {
    let removed = 0
    for (const [instanceId, binding] of this.instances) {
      if (binding.owner.serverId === serverId && binding.owner.runnerId === runnerId) {
        this.instances.delete(instanceId)
        this.abortBinding(binding)
        removed++
      }
    }
    try {
      this.store.invalidateRunner(String(serverId ?? ''), String(runnerId ?? ''))
    } catch {
    }
    return removed
  }

  invalidateRunnerId(runnerId: string): number {
    const id = String(runnerId ?? '')
    let removed = 0
    const serverIds = new Set<string>()
    for (const [instanceId, binding] of this.instances) {
      if (binding.owner.runnerId === id) {
        this.instances.delete(instanceId)
        this.abortBinding(binding)
        serverIds.add(binding.owner.serverId)
        removed++
      }
    }
    for (const serverId of serverIds) {
      try {
        this.store.invalidateRunner(serverId, id)
      } catch {
      }
    }
    return removed
  }

  resetForReload(): number {
    const removed = this.instances.size
    for (const binding of this.instances.values()) this.abortBinding(binding)
    this.instances.clear()
    this.callSessions.clear()
    try {
      this.store.clear()
    } catch {
    }
    return removed
  }

  close(): void {
    for (const binding of this.instances.values()) this.abortBinding(binding)
    this.instances.clear()
    this.callSessions.clear()
    this.store.clear()
  }

  private async handleToolsCall(
    binding: InstanceBinding,
    id: string | number,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const toolName = typeof params.name === 'string' ? params.name.trim() : ''
    if (!toolName) return this.rpcError(id, -32602, 'tools/call 缺少工具名')
    const args = asRecord(params.arguments) ?? {}
    const mode = await this.permissionMode()

    if (binding.inFlight >= this.maxConcurrent) {
      return this.rpcError(id, -32000, 'App 并发调用过多，请稍后再试')
    }
    binding.inFlight++
    try {
      let tools: McpAppToolDescriptor[]
      try {
        tools = await this.host.listToolsWithMeta(binding.serverId, {
          projectId: binding.facts.projectId,
          signal: binding.abort.signal
        })
      } catch (error) {
        return this.rpcError(id, -32000, `读取工具表失败：${messageOf(error)}`)
      }
      const tool = tools.find((entry) => entry.name === toolName)
      if (!tool) {
        await this.tryWriteAudit(binding, 'denied', toolName, mode, `未知工具：${toolName}`, { reason: '工具不在当前工具表里' })
        return this.rpcError(id, -32601, `当前服务没有工具 ${toolName}`)
      }

      const visibility: McpAppVisibility[] = mcpAppVisibilityOf(tool.meta)
      if (!visibility.includes('app')) {
        await this.tryWriteAudit(binding, 'denied', toolName, mode, `visibility 拒绝：${toolName}`, { reason: '工具未向 App 视图开放' })
        return this.rpcError(id, -32601, `工具 ${toolName} 未向 App 视图开放`)
      }

      const schemaError = validateToolArgs(tool.inputSchema, args)
      if (schemaError) {
        await this.tryWriteAudit(binding, 'denied', toolName, mode, `参数校验失败：${toolName}`, { reason: schemaError })
        return this.rpcError(id, -32602, schemaError)
      }

      const fingerprint = this.serverFingerprint(binding.serverId)
      if (!fingerprint) {
        await this.tryWriteAudit(binding, 'error', toolName, mode, `服务身份未知：${binding.serverId}`, { reason: '无法计算服务器身份指纹' })
        return this.rpcError(id, -32000, '无法确认服务器身份，拒绝调用')
      }

      const argsHash = hashMcpAppViewArgs(args)
      try {
        await this.writeAudit(binding, 'requested', toolName, mode, `App 请求调用 ${toolName}`, { argsHash })
      } catch (error) {
        return this.rpcError(id, -32000, `App 审计写入失败，已拒绝执行：${messageOf(error)}`)
      }

      let grants: readonly HostTrustGrant[]
      try {
        grants = await this.grantsOf(binding.facts, binding.serverId)
      } catch {
        grants = []
      }

      const decision = await approveAppViewCall(
        {
          server: binding.serverId,
          tool: toolName,
          visibility,
          annotations: tool.annotations,
          args,
          sessionId: binding.facts.sessionId,
          runId: binding.facts.runnerId,
          cwd: binding.facts.cwd,
          permissionMode: mode
        },
        this.ask,
        {
          serverFingerprint: fingerprint,
          grants,
          sessionId: binding.facts.sessionId,
          projectId: binding.facts.projectId,
          now: this.now()
        }
      )
      if (!decision.allowed) {
        await this.tryWriteAudit(binding, 'denied', toolName, mode, `拒绝调用 ${toolName}`, { reason: decision.reason ?? '未获授权' })
        return this.rpcError(id, -32000, decision.reason ?? '未获授权')
      }

      try {
        await this.writeAudit(binding, 'approved', toolName, mode, `允许调用 ${toolName}`, { argsHash })
      } catch (error) {
        return this.rpcError(id, -32000, `App 审计写入失败，已拒绝执行：${messageOf(error)}`)
      }

      if (!this.isOwnerActive(binding.owner) || this.serverFingerprint(binding.serverId) !== fingerprint) {
        await this.tryWriteAudit(binding, 'error', toolName, mode, `归属或服务身份已变化：${toolName}`, { reason: '调用前复核失败' })
        return this.rpcError(id, -32000, 'App 实例归属或服务身份已变化，拒绝调用')
      }

      let outcome: McpAppCallOutcome
      try {
        outcome = await this.host.callToolWithMeta(binding.serverId, toolName, args, {
          projectId: binding.facts.projectId,
          signal: binding.abort.signal
        })
      } catch (error) {
        await this.tryWriteAudit(binding, 'error', toolName, mode, `调用失败：${toolName}`, { reason: messageOf(error) })
        return this.rpcError(id, -32000, `工具调用失败：${messageOf(error)}`)
      }

      if (!this.isOwnerActive(binding.owner) || this.serverFingerprint(binding.serverId) !== fingerprint) {
        await this.tryWriteAudit(binding, 'error', toolName, mode, `迟到结果已丢弃：${toolName}`, { reason: '调用后复核失败' })
        return this.rpcError(id, -32000, 'App 实例归属或服务身份已变化，结果已丢弃')
      }

      await this.tryWriteAudit(binding, 'completed', toolName, mode, `调用完成：${toolName}`, { argsHash })
      const result = outcome.result ?? {
        content: [],
        ...(outcome.structuredContent ? { structuredContent: outcome.structuredContent } : {}),
        ...(outcome.meta ? { _meta: outcome.meta } : {})
      }
      return this.rpcResult(id, limitResultContent(result))
    } finally {
      binding.inFlight--
    }
  }

  private async handleResourcesRead(
    binding: InstanceBinding,
    id: string | number,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const uri = typeof params.uri === 'string' ? params.uri.trim() : ''
    if (!uri) return this.rpcError(id, -32602, 'resources/read 缺少资源 URI')
    if (uri !== binding.resourceUri) {
      return this.rpcError(id, -32601, '只允许读取本实例已声明的 App 资源')
    }
    if (binding.inFlight >= this.maxConcurrent) return this.rpcError(id, -32000, '并发请求过多')
    binding.inFlight++
    try {
      if (!this.isOwnerActive(binding.owner)) return this.rpcError(id, -32001, 'App 实例归属已失效')
      const resource = await this.host.readResource(binding.serverId, uri, {
        projectId: binding.facts.projectId,
        signal: binding.abort.signal
      })
      if (!this.isOwnerActive(binding.owner)) return this.rpcError(id, -32001, 'App 实例归属已失效')
      return this.rpcResult(id, {
        contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: resource.text }]
      })
    } catch (error) {
      return this.rpcError(id, -32000, `资源读取失败：${messageOf(error)}`)
    } finally {
      binding.inFlight--
    }
  }

  private async resolveHostContext(): Promise<Record<string, unknown>> {
    let provider: Record<string, unknown> = {}
    try {
      provider = asRecord(await this.hostContextProvider()) ?? {}
    } catch {
      provider = {}
    }
    return buildMcpAppHostContext({ theme: await this.resolveTheme(provider.theme), provider })
  }

  private async resolveTheme(providerTheme: unknown): Promise<McpAppTheme> {
    let preference: unknown
    if (this.theme) {
      try {
        preference = await this.theme()
      } catch {
        preference = undefined
      }
    }
    if (preference === undefined || preference === null) preference = providerTheme
    let systemPrefersDark = MCP_APP_DEFAULT_THEME === 'dark'
    if (this.systemPrefersDark) {
      try {
        systemPrefersDark = this.systemPrefersDark() === true
      } catch {
        systemPrefersDark = MCP_APP_DEFAULT_THEME === 'dark'
      }
    }
    return resolveMcpAppThemePreference(preference, systemPrefersDark)
  }

  private async resolveFacts(callId: string): Promise<McpAppViewRunnerFacts | null> {
    try {
      const facts = await this.runtime.resolve({ callId })
      return isFacts(facts) ? facts : null
    } catch {
      return null
    }
  }

  private async currentProjectId(): Promise<string | null> {
    try {
      const fn = this.runtime.currentProject
      if (!fn) return null
      const projectId = await fn()
      return typeof projectId === 'string' && projectId.trim() ? projectId.trim() : null
    } catch {
      return null
    }
  }

  private isOwnerActive(owner: McpAppOwner): boolean {
    try {
      return this.ownerGuard.isActive(owner) === true
    } catch {
      return false
    }
  }

  private serverFingerprint(serverId: string): string | null {
    let config: unknown | null
    try {
      config = this.serverConfigOf(serverId)
    } catch {
      return null
    }
    if (!config) return null
    return mcpServerIdentityFingerprint(config)
  }

  private async resolveResourceUri(
    record: McpAppViewCallRecordLike,
    facts: McpAppViewRunnerFacts
  ): Promise<string | null> {
    if (record.resourceUri) return record.resourceUri
    try {
      const tools = await this.host.listToolsWithMeta(record.serverId, { projectId: facts.projectId })
      return tools.find((tool) => tool.name === record.toolName)?.resourceUri ?? null
    } catch {
      return null
    }
  }

  private abortBinding(binding: InstanceBinding): void {
    try {
      binding.abort.abort(new Error('mcp-app-view-released'))
    } catch {
    }
  }

  private rememberCallSession(callId: string, sessionFile: string): void {
    this.callSessions.set(callId, sessionFile)
    while (this.callSessions.size > this.maxCallSessions) {
      const oldest = this.callSessions.keys().next().value
      if (oldest === undefined) break
      this.callSessions.delete(oldest)
    }
  }

  private rememberId(binding: InstanceBinding, id: string | number): boolean {
    const key = String(id)
    if (binding.seenIds.has(key)) return false
    binding.seenIds.add(key)
    if (binding.seenIds.size > this.maxSeenIds) {
      const oldest = binding.seenIds.values().next().value
      if (oldest !== undefined) binding.seenIds.delete(oldest)
    }
    return true
  }

  private async writeAudit(
    binding: InstanceBinding,
    phase: McpAppViewAuditEntry['phase'],
    toolName: string,
    mode: PermissionMode,
    summary: string,
    opts: { reason?: string; argsHash?: string } = {}
  ): Promise<McpAppViewAuditEntry> {
    return this.auditStore.record(binding.facts.sessionFile, {
      callId: binding.callId,
      toolName,
      phase,
      permissionMode: mode,
      summary,
      serverId: binding.serverId,
      instanceId: binding.instanceId,
      ...(opts.argsHash ? { argsHash: opts.argsHash } : {}),
      ...(opts.reason ? { reason: opts.reason } : {})
    })
  }

  private async tryWriteAudit(
    binding: InstanceBinding,
    phase: McpAppViewAuditEntry['phase'],
    toolName: string,
    mode: PermissionMode,
    summary: string,
    opts: { reason?: string; argsHash?: string } = {}
  ): Promise<void> {
    try {
      await this.writeAudit(binding, phase, toolName, mode, summary, opts)
    } catch {
    }
  }

  private parseRpc(message: unknown): ParsedRpcOk | ParsedRpcError {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return { ok: false, id: null, error: '消息必须是 JSON-RPC 2.0 对象' }
    }
    const record = message as Record<string, unknown>
    if (record.jsonrpc !== '2.0') return { ok: false, id: record.id ?? null, error: '缺少 jsonrpc:"2.0"' }
    const method = typeof record.method === 'string' ? record.method : ''
    if (!method || method.length > 128) return { ok: false, id: record.id ?? null, error: '缺少有效的方法名' }
    let id: string | number | undefined
    if (record.id !== undefined && record.id !== null) {
      if (typeof record.id === 'string') {
        if (record.id.length > 128) return { ok: false, id: null, error: '请求 ID 过长' }
        id = record.id
      } else if (typeof record.id === 'number' && Number.isFinite(record.id)) {
        id = record.id
      } else {
        return { ok: false, id: null, error: '请求 ID 形状不合法' }
      }
    }
    let serialized: string
    try {
      serialized = JSON.stringify(message)
    } catch {
      return { ok: false, id: record.id ?? null, error: '消息无法序列化' }
    }
    if (Buffer.byteLength(serialized, 'utf8') > this.maxMessageBytes) {
      return { ok: false, id: record.id ?? null, error: '消息超过体积上限' }
    }
    const params = record.params === undefined ? {} : asRecord(record.params)
    if (!params) return { ok: false, id: record.id ?? null, error: 'params 必须是对象' }
    return { ok: true, id, method, params }
  }

  private rpcResult(id: string | number | undefined, result: unknown): Record<string, unknown> {
    return { jsonrpc: '2.0', id: id ?? null, result }
  }

  private rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
    return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
  }
}
