import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile, copyFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  addAuthorization,
  authorizationCovers,
  type AcquireAuthorization,
  type ManagedMcpRecord,
  type McpRegistrationDraft
} from '../../shared/mcp-registration'
import { classifyAcquisitionFailure } from '../../shared/acquisition'
import type { McpServerConfig } from '../../shared/mcp'
import { McpConnectionManager } from '../mcp/connection-manager'
import { loadMcpServers, mcpServersFile } from '../mcp/config'
import {
  createDefaultSettingsSafeAccess,
  managedConfigById,
  probeManagedServer
} from '../mcp/settings-safe-access'
import { acquisitionRoot } from './acquisition-service'

export const AUTHORIZATIONS_FILENAME = 'authorizations.json'
export const MANAGED_MCP_FILENAME = 'mcp-managed.json'

export class McpRegistrationError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'McpRegistrationError'
  }
}

export type McpProbeResult = { tools: string[] }

export type McpProbeContext = { projectId?: string }

export type McpProbe = (config: McpServerConfig, context?: McpProbeContext) => Promise<McpProbeResult>

export type McpRegistrationOutcome = {
  serverId: string
  config: McpServerConfig
  configPath: string
  tools: string[]
  warnings: string[]
}

export type McpRegistrationOptions = {
  root: string
  env?: NodeJS.ProcessEnv
  probe?: McpProbe
}

export function authorizationsPath(root: string): string {
  return join(acquisitionRoot(root), AUTHORIZATIONS_FILENAME)
}

export function managedMcpPath(root: string): string {
  return join(acquisitionRoot(root), MANAGED_MCP_FILENAME)
}

async function writeFileAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, path)
}

async function quarantineRecord(path: string): Promise<void> {
  await copyFile(path, `${path}.corrupt-${Date.now()}-${Math.random().toString(36).slice(2)}`).catch(() => undefined)
}

async function readJsonArray<T>(path: string): Promise<T[]> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    await quarantineRecord(path)
    throw new McpRegistrationError('record-invalid', `MCP 登记记录损坏，已拒绝覆盖（${path}）：${error instanceof Error ? error.message : String(error)}`)
  }
  if (Array.isArray(parsed)) return parsed as T[]
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { items?: unknown }).items)) {
    return (parsed as { items: T[] }).items
  }
  await quarantineRecord(path)
  throw new McpRegistrationError('record-invalid', `MCP 登记记录格式无效，已拒绝覆盖：${path}`)
}

async function readRawServers(path: string): Promise<{ shape: 'array' | 'object'; list: unknown[] }> {
  if (!existsSync(path)) return { shape: 'array', list: [] }
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (Array.isArray(parsed)) return { shape: 'array', list: parsed }
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { servers?: unknown }).servers)) {
      return { shape: 'object', list: (parsed as { servers: unknown[] }).servers }
    }
    throw new McpRegistrationError('config-invalid', `MCP 配置不是数组或 { servers: [...] }：${path}`)
  } catch (error) {
    if (error instanceof McpRegistrationError) throw error
    throw new McpRegistrationError(
      'config-invalid',
      `MCP 配置不是合法 JSON（${path}）：${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function configIdOf(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null
  const id = (raw as { id?: unknown }).id
  return typeof id === 'string' && id.trim() ? id.trim() : null
}

function configUrlOf(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null
  const url = (raw as { url?: unknown }).url
  return typeof url === 'string' ? url : null
}

function isManagedRaw(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false
  const record = raw as { ownedBy?: unknown; appHost?: unknown }
  return record.ownedBy === 'inkstone' && Boolean(record.appHost && typeof record.appHost === 'object')
}

function defaultProbe(timeoutMs = 20_000): McpProbe {
  return async (config, context) => {
    const access = createDefaultSettingsSafeAccess()
    if (managedConfigById(access, config.id)) {
      return probeManagedServer(access, config.id, context?.projectId)
    }
    await access.host().reconcile(config.id)
    const manager = new McpConnectionManager([config], timeoutMs)
    try {
      const tools = await manager.listTools(config.id)
      return { tools: tools.map((tool) => tool.name) }
    } finally {
      await manager.close().catch(() => undefined)
    }
  }
}

export class McpRegistrationService {
  private readonly root: string
  private readonly env: NodeJS.ProcessEnv
  private readonly probe: McpProbe

  constructor(options: McpRegistrationOptions) {
    this.root = options.root
    this.env = options.env ?? process.env
    this.probe = options.probe ?? defaultProbe()
  }

  get configPath(): string {
    return mcpServersFile(this.env)
  }

  async listAuthorizations(): Promise<AcquireAuthorization[]> {
    return readJsonArray<AcquireAuthorization>(authorizationsPath(this.root))
  }

  async listManaged(): Promise<ManagedMcpRecord[]> {
    return readJsonArray<ManagedMcpRecord>(managedMcpPath(this.root))
  }

  async isAuthorized(url: string, projectId?: string): Promise<boolean> {
    return authorizationCovers(await this.listAuthorizations(), url, projectId)
  }

  async authorize(input: { url: string; via: string; projectId?: string; at?: string }): Promise<AcquireAuthorization> {
    const host = new URL(input.url).host.toLowerCase()
    const record: AcquireAuthorization = {
      host,
      at: input.at ?? new Date().toISOString(),
      via: input.via,
      ...(input.projectId ? { projectId: input.projectId } : {})
    }
    const next = addAuthorization(await this.listAuthorizations(), record)
    await writeFileAtomic(authorizationsPath(this.root), JSON.stringify({ items: next }, null, 2))
    return record
  }

  async registerRemote(input: {
    draft: McpRegistrationDraft
    projectId: string
    operationId: string
    at?: string
  }): Promise<McpRegistrationOutcome> {
    const at = input.at ?? new Date().toISOString()
    const { draft } = input
    const path = this.configPath
    const raw = await readRawServers(path)
    const existing = raw.list.find((item) => configIdOf(item) === draft.serverId)
    if (existing) {
      if (isManagedRaw(existing)) {
        throw new McpRegistrationError(
          'server-managed-by-inkstone',
          `服务 ${draft.serverId} 正由砚托管，登记不会覆盖它；请先在设置 → 能力里交回 pi 原生`
        )
      }
      const url = configUrlOf(existing)
      if (url && url !== draft.config.url) {
        throw new McpRegistrationError(
          'server-id-conflict',
          `已存在同名服务 ${draft.serverId} 但端点不同（${url}）——不覆盖，请先移除或换一个候选`
        )
      }
    }

    let probe: McpProbeResult
    try {
      probe = await this.probe(draft.config, { projectId: input.projectId })
    } catch (error) {
      const code = classifyAcquisitionFailure(error)
      const message = error instanceof Error ? error.message : String(error)
      throw new McpRegistrationError(code === 'network' ? 'endpoint-unreachable' : `probe-${code}`, message)
    }

    const wrote = !existing
    if (wrote) {
      const nextList = [...raw.list, draft.config]
      const payload = raw.shape === 'array' ? nextList : { servers: nextList }
      try {
        await writeFileAtomic(path, JSON.stringify(payload, null, 2))
      } catch (error) {
        throw new McpRegistrationError(
          'config-write-failed',
          `写 MCP 配置失败（${path}）：${error instanceof Error ? error.message : String(error)}`
        )
      }
    }

    try {
      const records = await this.listManaged()
      const next: ManagedMcpRecord[] = records.filter((record) => record.serverId !== draft.serverId)
      next.push({
        serverId: draft.serverId,
        operationId: input.operationId,
        endpoint: draft.endpoint,
        host: draft.host,
        transport: 'http',
        projectId: input.projectId,
        registeredAt: at,
        tools: probe.tools
      })
      await writeFileAtomic(managedMcpPath(this.root), JSON.stringify({ items: next }, null, 2))
    } catch (error) {
      if (wrote) {
        try {
          const current = await readRawServers(path)
          const filtered = current.list.filter((item) => configIdOf(item) !== draft.serverId)
          const payload = current.shape === 'array' ? filtered : { servers: filtered }
          await writeFileAtomic(path, JSON.stringify(payload, null, 2))
        } catch {
        }
      }
      throw new McpRegistrationError(
        'record-write-failed',
        `写受管登记记录失败：${error instanceof Error ? error.message : String(error)}`
      )
    }

    return {
      serverId: draft.serverId,
      config: draft.config,
      configPath: path,
      tools: probe.tools,
      warnings: draft.warnings
    }
  }

  async registerStdio(input: {
    config: McpServerConfig
    projectId: string
    operationId: string
    at?: string
    probe?: McpProbe
  }): Promise<McpRegistrationOutcome> {
    const at = input.at ?? new Date().toISOString()
    const config: McpServerConfig = {
      ...input.config,
      transport: 'stdio',
      projectScope: input.projectId,
      effect: 'unknown',
      enabled: true
    }
    if (!config.id || !config.command || (config.args ?? []).some((arg) => typeof arg !== 'string')) {
      throw new McpRegistrationError('config-invalid', '本地 MCP 配置缺少 id / command 或参数不是字符串')
    }

    const path = this.configPath
    const raw = await readRawServers(path)
    const existing = raw.list.find((item) => configIdOf(item) === config.id)
    const existingConfig = existing && typeof existing === 'object' ? existing as Record<string, unknown> : null
    if (existingConfig) {
      if (isManagedRaw(existingConfig)) {
        throw new McpRegistrationError(
          'server-managed-by-inkstone',
          `服务 ${config.id} 正由砚托管，登记不会覆盖它；请先在设置 → 能力里交回 pi 原生`
        )
      }
      const same = existingConfig.transport === 'stdio' &&
        existingConfig.command === config.command &&
        JSON.stringify(existingConfig.args ?? []) === JSON.stringify(config.args ?? []) &&
        existingConfig.projectScope === config.projectScope
      if (!same) {
        throw new McpRegistrationError('server-id-conflict', `已存在同名本地 MCP 服务 ${config.id}，但命令或项目范围不同——不覆盖`)
      }
    }

    let probe: McpProbeResult
    try {
      probe = await (input.probe ?? this.probe)(config, { projectId: input.projectId })
    } catch (error) {
      const code = classifyAcquisitionFailure(error)
      const message = error instanceof Error ? error.message : String(error)
      throw new McpRegistrationError(code === 'network' ? 'stdio-unreachable' : `probe-${code}`, message)
    }

    const wrote = !existing
    if (wrote) {
      const nextList = [...raw.list, config]
      const payload = raw.shape === 'array' ? nextList : { servers: nextList }
      try {
        await writeFileAtomic(path, JSON.stringify(payload, null, 2))
      } catch (error) {
        throw new McpRegistrationError(
          'config-write-failed',
          `写本地 MCP 配置失败（${path}）：${error instanceof Error ? error.message : String(error)}`
        )
      }
    }

    try {
      const records = await this.listManaged()
      const next: ManagedMcpRecord[] = records.filter((record) => record.serverId !== config.id)
      next.push({
        serverId: config.id,
        operationId: input.operationId,
        endpoint: `stdio://${config.id}`,
        host: 'local',
        transport: 'stdio',
        projectId: input.projectId,
        registeredAt: at,
        tools: probe.tools
      })
      await writeFileAtomic(managedMcpPath(this.root), JSON.stringify({ items: next }, null, 2))
    } catch (error) {
      if (wrote) {
        try {
          const current = await readRawServers(path)
          const filtered = current.list.filter((item) => configIdOf(item) !== config.id)
          const payload = current.shape === 'array' ? filtered : { servers: filtered }
          await writeFileAtomic(path, JSON.stringify(payload, null, 2))
        } catch {
        }
      }
      throw new McpRegistrationError(
        'record-write-failed',
        `写本地 MCP 受管登记失败：${error instanceof Error ? error.message : String(error)}`
      )
    }

    return {
      serverId: config.id,
      config,
      configPath: path,
      tools: probe.tools,
      warnings: ['本地 MCP 包以项目范围受管 stdio 配置运行；staging 不是 OS 沙箱。']
    }
  }

  async reverify(record: ManagedMcpRecord): Promise<{ ok: boolean; reasons: string[] }> {
    const reasons: string[] = []
    const raw = await readRawServers(this.configPath)
    const item = raw.list.find((entry) => configIdOf(entry) === record.serverId)
    if (!item) {
      return { ok: false, reasons: [`配置里已经没有 ${record.serverId}（被移除或改名）`] }
    }
    const transport = record.transport ?? 'http'
    let probeConfig: McpServerConfig
    if (transport === 'stdio') {
      const loaded = loadMcpServers(this.env)
      const config = loaded.servers.find((server) => server.id === record.serverId)
      if (!config || config.transport !== 'stdio' || config.projectScope !== record.projectId) {
        reasons.push(`${record.serverId} 的受管 stdio 配置已被移除、改 transport 或脱离项目范围`)
        return { ok: false, reasons }
      }
      probeConfig = config
    } else {
      if (configUrlOf(item) !== record.endpoint) {
        reasons.push(`${record.serverId} 的端点已被改成 ${configUrlOf(item) ?? '（空）'}，与登记时不同`)
      }
      probeConfig = {
        id: record.serverId,
        transport: 'http',
        url: record.endpoint,
        effect: 'unknown',
        enabled: true
      }
    }
    try {
      const probe = await this.probe(probeConfig, { projectId: record.projectId })
      const missing = record.tools.filter((tool) => !probe.tools.includes(tool))
      if (missing.length && record.tools.length) {
        reasons.push(`${record.serverId} 少了登记时存在的工具：${missing.join(', ')}`)
      }
    } catch (error) {
      reasons.push(`${record.serverId} 连不上：${error instanceof Error ? error.message : String(error)}`)
    }
    return { ok: reasons.length === 0, reasons }
  }
}
