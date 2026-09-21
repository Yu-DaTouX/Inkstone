/**
 * 远程 MCP 的**登记**（实施-04 S6b-1，§10 的 `acquiring → verifying → activated`）。
 *
 * ── 这一层负责什么 ──
 *   把「目录里的一条远程候选」变成「宿主真的连得上、并且写进了受管配置的服务」：
 *   先**真连一次**枚举工具（端点核验），再原子写 `mcp-servers.json`，
 *   最后写受管登记记录（卸载时只删自己登记的那些）。
 *
 * ── 为什么核验必须在写配置**之前** ──
 *   写进去再连，用户会先看到一条「已登记」的服务，然后发现它连不上 ——
 *   那正是 §11 要避免的「登记了就算有」。核验失败就如实报 `needs-auth` / 不可达，
 *   配置一个字节都不改。
 *
 * ── 为什么配置只能由宿主写 ──
 *   `command` / `url` 决定「会执行什么代码、连到哪里」。模型能改配置就等于拿到了
 *   一个任意命令执行入口（`mcp/config.ts` 的注释已经写了这条）。所以登记入口是
 *   `capabilities.acquire`，参数只能是 `planId`，真实端点从宿主持有的候选里取。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
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

export type McpProbe = (config: McpServerConfig) => Promise<McpProbeResult>

export type McpRegistrationOutcome = {
  serverId: string
  config: McpServerConfig
  configPath: string
  tools: string[]
  warnings: string[]
}

export type McpRegistrationOptions = {
  /** 受管根目录（生产是 `YAN_DIR`；测试用临时目录）。 */
  root: string
  env?: NodeJS.ProcessEnv
  /** 端点核验；默认真连一次。测试注入假实现，但**生产路径与测试路径走的是同一段代码**。 */
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

async function readJsonArray<T>(path: string): Promise<T[]> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (Array.isArray(parsed)) return parsed as T[]
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { items?: unknown }).items)) {
      return (parsed as { items: T[] }).items
    }
    return []
  } catch {
    return []
  }
}

/** 读回配置文件的**原始结构**（保留未知字段 / 手写条目，不用 loadMcpServers 的归一化结果回写）。 */
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

/** 默认端点核验：真连一次并枚举工具（用与运行时**同一个**连接管理器）。 */
function defaultProbe(timeoutMs = 20_000): McpProbe {
  return async (config) => {
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

  /** 记录一条来源授权（`--authorize`）。幂等：同一个 host + 项目只保留一条。 */
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

  /**
   * 登记一个远程 MCP 服务。
   *
   * 顺序刻意是 **核验 → 写配置 → 写受管记录**：
   *   核验失败一个字节都不写；写受管记录失败时把刚写进去的那条配置撤回（只撤本次 id + 同一 url）。
   */
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
      probe = await this.probe(draft.config)
    } catch (error) {
      const code = classifyAcquisitionFailure(error)
      const message = error instanceof Error ? error.message : String(error)
      /* 认证类失败要如实报 `needs-auth`，不能混成「不可达」让用户去查网络。 */
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
      /* 撤回本次写入：只在「真的是这次写进去的」时删，幂等情形不碰。 */
      if (wrote) {
        try {
          const current = await readRawServers(path)
          const filtered = current.list.filter((item) => configIdOf(item) !== draft.serverId)
          const payload = current.shape === 'array' ? filtered : { servers: filtered }
          await writeFileAtomic(path, JSON.stringify(payload, null, 2))
        } catch {
          /* 撤回失败也不能掩盖原始错误 —— 让调用方按「登记失败但配置可能残留」如实报。 */
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

  /**
   * 登记一个受管本地 MCP 包。它与远程登记共用同一条「先真连、后写配置」边界，
   * 但不走 host 授权，也不把 stdio 命令暴露给模型：调用方必须先从固定 npm
   * staging 中解析出入口并构造这份配置。
   */
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
      probe = await (input.probe ?? this.probe)(config)
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
          /* 保留原始错误；配置残留会在下一次复核时明确暴露。 */
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

  /** 恢复复核：服务还在配置里、端点没被换、仍能握手并列出工具（**不看日志**）。 */
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
      const probe = await this.probe(probeConfig)
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
