import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { McpAppServerConfig } from './app-spec'

export interface McpAppOwnershipProject {
  id: string
  cwd: string
}

export interface McpAppRuntimeHolder {
  id: string
  label?: string
}

export interface McpAppRuntimeHolderQuery {
  serverId: string
  scope: 'global' | 'project'
  projectId?: string
  managedAt?: string
}

export type McpAppRuntimeHolderProvider = (
  query: McpAppRuntimeHolderQuery
) => Promise<readonly McpAppRuntimeHolder[]>

export interface McpAppOwnershipFacts {
  agentDir?: string
  projects?: readonly McpAppOwnershipProject[]
  readNativeConfig?: (path: string) => Promise<string | null>
  holdersFor?: McpAppRuntimeHolderProvider
}

export type McpAppOwnershipFactsSource =
  | McpAppOwnershipFacts
  | (() => McpAppOwnershipFacts | Promise<McpAppOwnershipFacts>)

export type McpAppOwnershipCode =
  | 'not-managed'
  | 'path-scope-unknown'
  | 'native-unreadable'
  | 'native-invalid-json'
  | 'native-still-present'
  | 'runtime-unknown'
  | 'runtime-holders-active'
  | 'project-unregistered'
  | 'project-mismatch'
  | 'ownership-changed'

export interface McpAppOwnershipRejection {
  ok: false
  code: McpAppOwnershipCode
  message: string
}

export interface McpAppOwnershipApproval {
  ok: true
}

export type McpAppOwnershipDecision = McpAppOwnershipApproval | McpAppOwnershipRejection

export interface McpAppOwnershipCheckInput {
  serverId: string
  config: McpAppServerConfig
  callerProjectId?: string
}

export class McpAppOwnershipError extends Error {
  constructor(
    readonly code: McpAppOwnershipCode,
    message: string
  ) {
    super(message)
    this.name = 'McpAppOwnershipError'
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function reject(code: McpAppOwnershipCode, message: string): McpAppOwnershipRejection {
  return { ok: false, code, message }
}

async function defaultReadNativeConfig(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function nativeNamesOf(serverId: string, config: McpAppServerConfig): Set<string> {
  const names = new Set<string>()
  const id = serverId.trim()
  if (id) names.add(id)
  for (const native of config.appHost?.natives ?? []) {
    if (native && typeof native.name === 'string' && native.name.trim()) names.add(native.name.trim())
  }
  return names
}

function nativeLocations(facts: McpAppOwnershipFacts, config: McpAppServerConfig, agentDir: string): string[] {
  const paths = new Set<string>()
  for (const native of config.appHost?.natives ?? []) {
    if (native && typeof native.path === 'string' && native.path.trim()) paths.add(native.path.trim())
  }
  paths.add(join(agentDir, 'mcp.json'))
  for (const project of facts.projects ?? []) {
    if (project && typeof project.cwd === 'string' && project.cwd.trim()) {
      paths.add(join(project.cwd.trim(), '.pi', 'mcp.json'))
    }
  }
  return [...paths]
}

function nativeNamesPresent(parsed: unknown, names: ReadonlySet<string>): boolean | undefined {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const servers = (parsed as Record<string, unknown>).mcpServers
  if (servers === undefined) return false
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return undefined
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(servers, name)) return true
  }
  return false
}

export class McpAppOwnershipGuard {
  constructor(private readonly source: McpAppOwnershipFactsSource = {}) {}

  private async facts(): Promise<McpAppOwnershipFacts> {
    const value = typeof this.source === 'function' ? await this.source() : this.source
    return value ?? {}
  }

  async check(input: McpAppOwnershipCheckInput): Promise<McpAppOwnershipDecision> {
    const facts = await this.facts()
    const { config } = input

    let scope: 'global' | 'project' = 'global'
    let projectId: string | undefined
    if (typeof config.projectScope === 'string' && config.projectScope.trim()) {
      projectId = config.projectScope.trim()
      scope = 'project'
      const project = (facts.projects ?? []).find(
        (entry) => entry && entry.id === projectId && typeof entry.cwd === 'string' && entry.cwd.trim().length > 0
      )
      if (!project) {
        return reject(
          'project-unregistered',
          `服务 ${input.serverId} 的项目范围 ${projectId} 不在受信项目登记里，拒绝连接`
        )
      }
      if (input.callerProjectId !== projectId) {
        return reject(
          'project-mismatch',
          `服务 ${input.serverId} 属于项目 ${projectId}，当前调用者不是该项目，拒绝跨项目连接`
        )
      }
    }

    const agentDir = typeof facts.agentDir === 'string' ? facts.agentDir.trim() : ''
    if (!agentDir) {
      return reject(
        'path-scope-unknown',
        `没有可信的 pi agent 目录，无法确认 pi 侧是否仍有服务 ${input.serverId} 的条目，拒绝连接`
      )
    }

    if (typeof facts.holdersFor !== 'function') {
      return reject(
        'runtime-unknown',
        `主进程没有提供可靠的 runner 持有情况，无法确认旧 pi 是否已退出，拒绝连接服务 ${input.serverId}`
      )
    }
    let holders: readonly McpAppRuntimeHolder[]
    try {
      holders = await facts.holdersFor({
        serverId: input.serverId,
        scope,
        ...(projectId ? { projectId } : {}),
        ...(typeof config.appHost?.at === 'string' && config.appHost.at.trim() ? { managedAt: config.appHost.at.trim() } : {})
      })
    } catch (error) {
      return reject('runtime-unknown', `读取 runner 持有情况失败，拒绝连接服务 ${input.serverId}：${messageOf(error)}`)
    }
    if (!Array.isArray(holders)) {
      return reject('runtime-unknown', `runner 持有情况不是数组，无法确认旧 pi 是否已退出，拒绝连接服务 ${input.serverId}`)
    }
    if (holders.length > 0) {
      return reject(
        'runtime-holders-active',
        `仍有 ${holders.length} 个运行实例可能持有服务 ${input.serverId}，未确认退出前拒绝连接`
      )
    }

    const names = nativeNamesOf(input.serverId, config)
    const readNative = facts.readNativeConfig ?? defaultReadNativeConfig
    for (const path of nativeLocations(facts, config, agentDir)) {
      let text: string | null
      try {
        text = await readNative(path)
      } catch (error) {
        return reject('native-unreadable', `无法读取 pi 原生配置 ${path}，拒绝连接：${messageOf(error)}`)
      }
      if (text === null) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch (error) {
        return reject('native-invalid-json', `pi 原生配置不是合法 JSON（${path}），拒绝连接：${messageOf(error)}`)
      }
      const present = nativeNamesPresent(parsed, names)
      if (present === undefined) {
        return reject('native-invalid-json', `pi 原生配置形状不对（${path}），拒绝连接`)
      }
      if (present) {
        return reject(
          'native-still-present',
          `pi 原生配置 ${path} 里仍有服务「${[...names].join('、')}」，移除前拒绝由砚连接`
        )
      }
    }

    return { ok: true }
  }
}
