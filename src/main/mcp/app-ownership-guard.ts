/**
 * MCP Apps 归属守卫：连接前的**事实核对**，不是配置声明的复述。
 *
 * ── 它为什么存在 ──
 *   `ownedBy:'inkstone'` 只是砚配置里的**自述**。真正要回答「现在能不能由砚连接」，
 *   还必须证明两件事：
 *     1. pi 侧**所有相关配置**（切换时逐字保存的 natives 路径 + 全局
 *        `PI_AGENT_DIR/mcp.json` + 受信项目 `.pi/mcp.json`）都没有同名条目；
 *     2. 没有仍可能持有该服务的旧 pi 运行实例。
 *   任何一条无法确认，都按「不能连」处理 —— 见 `AGENTS.md`「移除配置 ≠ 断开连接」。
 *
 * ── fail-closed ──
 *   · 不知道 pi agent 目录 → 路径范围不明，拒绝；
 *   · 任何 pi 配置读失败或 JSON 损坏 → 拒绝；
 *   · 未注入 runner 持有情况 provider → 运行时未知，拒绝（**不默认「无活跃 runner」**）；
 *   · 项目范围未登记或调用者跨项目 → 拒绝。
 *
 * ── 边界 ──
 *   本模块**不实现 runner 注册表**，只消费宿主注入的 `holdersFor`。持有情况的语义
 *   （谁算「可能仍持有」、何时算「已确认退出」）由主进程接线处决定；本模块只把
 *   非空结果当作「未确认退出」。
 *
 *   本模块也不做落盘；`reconcile` / `disconnect` 在 `app-host` 侧。调用者不能自报
 *   守卫通过：守卫由主进程在构造宿主时注入，请求端无法传入或替换。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { McpAppServerConfig } from './app-spec'

/** 受信项目登记：`projectId → cwd` 只由宿主提供，不按目录反推。 */
export interface McpAppOwnershipProject {
  id: string
  cwd: string
}

/** 可能仍持有该服务的运行实例。 */
export interface McpAppRuntimeHolder {
  id: string
  label?: string
}

export interface McpAppRuntimeHolderQuery {
  serverId: string
  scope: 'global' | 'project'
  projectId?: string
  /** 砚托管声明的时间（`appHost.at`）；旧 runner 若在此之后创建，可认为其 pi 配置已不含该条目。 */
  managedAt?: string
}

/**
 * 运行时旧 pi 持有情况。返回**空数组**才表示「已明确确认没有可能持有的实例」；
 * 未提供 provider 表示「未知」，守卫一律拒绝。
 */
export type McpAppRuntimeHolderProvider = (
  query: McpAppRuntimeHolderQuery
) => Promise<readonly McpAppRuntimeHolder[]>

/** 宿主必须注入的归属事实；缺任何一项都只会让守卫更严，不会更松。 */
export interface McpAppOwnershipFacts {
  /** pi 的 agent 目录（全局 `mcp.json` 落在这里）。缺省 → 路径范围不明。 */
  agentDir?: string
  /** 受信项目登记。 */
  projects?: readonly McpAppOwnershipProject[]
  /** 读 pi 原生配置文本；`null` 表示文件不存在。缺省用 fs（只区分 ENOENT，其它错误拒绝）。 */
  readNativeConfig?: (path: string) => Promise<string | null>
  /** 运行时持有情况 provider；缺省 → 运行时未知，拒绝。 */
  holdersFor?: McpAppRuntimeHolderProvider
}

/** 事实可以每次动态求值（项目登记 / runner 注册表会变），也可以给固定对象。 */
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
  /** 调用者所在项目；由主进程提供，用来挡跨项目越权。 */
  callerProjectId?: string
}

/** 归属守卫拒绝连接时的错误；`code` 供上层如实展示与测试断言。 */
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

/** 缺省 fs 读：只把 ENOENT 当「不存在」，其余读失败照实抛出（守卫转成拒绝）。 */
async function defaultReadNativeConfig(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** 该服务在 pi 侧可能用到的名字：砚 id + 切换时保存的原名。 */
function nativeNamesOf(serverId: string, config: McpAppServerConfig): Set<string> {
  const names = new Set<string>()
  const id = serverId.trim()
  if (id) names.add(id)
  for (const native of config.appHost?.natives ?? []) {
    if (native && typeof native.name === 'string' && native.name.trim()) names.add(native.name.trim())
  }
  return names
}

/** 所有相关 pi 配置路径：保存的 natives 路径 + 全局 + 受信项目；去重。 */
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

/**
 * pi 原生配置里是否有同名条目。
 * 返回 `undefined` 表示形状不认识 —— 宁可按坏文件拒绝，也不猜。
 */
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

  /**
   * 连接资格判定。**任何不确定都返回拒绝**；调用方必须把 `ok:false` 当作硬性阻断，
   * 不能拿「旧状态」继续。缺省事实（空对象）会让 agentDir / holdersFor 都缺失，
   * 从而拒绝一切连接 —— 这正是主进程未接线时的期望行为。
   */
  async check(input: McpAppOwnershipCheckInput): Promise<McpAppOwnershipDecision> {
    const facts = await this.facts()
    const { config } = input

    /* 1. 项目范围：必须登记，且调用者不得跨项目。 */
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

    /* 2. 路径范围：不知道 pi agent 目录就无法核对 pi 侧配置。 */
    const agentDir = typeof facts.agentDir === 'string' ? facts.agentDir.trim() : ''
    if (!agentDir) {
      return reject(
        'path-scope-unknown',
        `没有可信的 pi agent 目录，无法确认 pi 侧是否仍有服务 ${input.serverId} 的条目，拒绝连接`
      )
    }

    /* 3. 运行时旧 pi 持有情况：未提供 provider = 未知，fail-closed。 */
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

    /* 4. pi 侧所有相关配置都不得有同名条目。 */
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
