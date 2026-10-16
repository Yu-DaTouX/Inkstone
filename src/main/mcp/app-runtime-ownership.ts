/**
 * MCP Apps 宿主的**真实运行时归属事实**。
 *
 * ── 它补的是什么 ──
 *   FIX3 的 `McpAppOwnershipGuard` 默认 fail-closed：没有事实就一律拒绝连接，
 *   这是对的；但只按 `statuses()` / `managedAt` 判断「旧 pi 是否还持有」会走到
 *   两个极端：
 *     · 把**所有存活 runner** 都当旧持有者 → 托管后新会话被永久拒绝（FIX3 +
 *       MA3R 现状：`managedAt` 与 `Date.now()` 比较不构成证据，不能用来排除）；
 *     · 或者反过来把不确定当「无人持有」→ 双连接。
 *
 *   本模块把 MA3R 的窄快照（含 hidden）与 `app-native-witness.ts` 的启动见证
 *   合起来做**证据化**判定：只有「这个 runner 启动时确实没加载目标服务、之后
 *   文件也没变过、进程仍活着、身份对得上」才把它从旧持有者里排除；其余一律
 *   按可能持有处理。时间戳不参与判定。
 *
 * ── 复用点 ──
 *   · `mayHoldMcpApp()`：范围闸门（哪些 runner 才有资格算持有者）在这里统一，
 *     IPC 切换路径与本模块共用，避免两处口径漂移；
 *   · `createMcpAppRuntimeOwnershipFacts()`：给 `configureMcpAppHostOwnership`
 *     的动态事实源；`holdersFor` 抛错 = 未知 = 上层拒绝，绝不返回空数组。
 */
import { loadMcpServers } from './config'
import { nativeMcpServerName } from '../../shared/mcp-native-import'
import type { McpAppServerConfig } from './app-spec'
import type {
  McpAppOwnershipFacts,
  McpAppOwnershipProject,
  McpAppRuntimeHolder,
  McpAppRuntimeHolderQuery
} from './app-ownership-guard'
import type { RunnerRegistry, McpHolderSnapshot } from '../runners'
import {
  nativeWitnessIdentityMatches,
  verifyNativeStartupWitness,
  type McpNativeBootWitness,
  type McpNativeConfigReader
} from './app-native-witness'

/** 目标服务在 pi 原生配置里可能用到的名字：砚 id、保存的原名、可导出的原生名。 */
export function mcpAppHolderNames(serverId: string, config?: McpAppServerConfig): Set<string> {
  const names = new Set<string>()
  const id = typeof serverId === 'string' ? serverId.trim() : ''
  if (id) {
    names.add(id)
    const derived = nativeMcpServerName(id)
    if (derived.ok) names.add(derived.name)
  }
  for (const native of config?.appHost?.natives ?? []) {
    if (native && typeof native.name === 'string' && native.name.trim()) names.add(native.name.trim())
  }
  return names
}

/** 保守持有判定（范围闸门）：只排除「确定已退出」与「已知属于其它项目」的实例。 */
export function mayHoldMcpApp(
  snapshot: Pick<McpHolderSnapshot, 'processRunning' | 'conn' | 'projectId'>,
  server: { serverId: string; scope: 'global' | 'project'; projectId?: string }
): boolean {
  if (!snapshot.processRunning && snapshot.conn === 'exited') return false
  if (server.scope === 'global') return true
  if (snapshot.projectId) return snapshot.projectId === server.projectId
  return true
}

/**
 * 范围闸门 + **legacy 连接事实**：pi 进程退出不等于 AgentController 里的
 * legacy MCP client 已断。
 *
 * - `legacyMcpServices` 缺失（undefined / null）= 没法确认 → 一律可能持有；
 * - 目标 serverId 的 legacy 状态为 ready / connecting → 可能持有；
 * - 其余才回到「确定已退出且跨项目排除」的 `mayHoldMcpApp` 判定。
 *
 * 切换（to-inkstone）与宿主连接路径共用本函数，口径不漂移。
 */
export function mayHoldMcpAppWithLegacy(
  snapshot: Pick<McpHolderSnapshot, 'processRunning' | 'conn' | 'projectId' | 'legacyMcpServices'>,
  server: { serverId: string; scope: 'global' | 'project'; projectId?: string }
): boolean {
  const legacy = snapshot.legacyMcpServices
  if (legacy === null || legacy === undefined) return true
  if (
    legacy.some(
      (service) =>
        service && service.serverId === server.serverId && (service.status === 'ready' || service.status === 'connecting')
    )
  ) {
    return true
  }
  return mayHoldMcpApp(snapshot, server)
}

/** 见证证据的纯判定（不做 IO）：身份一致 + 完整采集 + 启动集合里没有任何目标名字。 */
export function witnessProvesAbsent(input: {
  witness: McpNativeBootWitness | null | undefined
  snapshot: Pick<McpHolderSnapshot, 'generation' | 'cwd' | 'processRunning' | 'conn'>
  names: ReadonlySet<string>
  /** 项目服务必须证明该 runner 的 cwd 就是服务所属项目目录。 */
  projectCwd?: string
}): { proven: boolean; reason: string } {
  const { witness, snapshot, names, projectCwd } = input
  if (!witness) return { proven: false, reason: '没有启动见证' }
  if (!snapshot.processRunning) return { proven: false, reason: '进程未确认存活' }
  /* 只有 ready 才算配置已加载完成；starting / error / exited 一律不证明。 */
  if (snapshot.conn !== 'ready') return { proven: false, reason: `连接状态不是 ready（${snapshot.conn}）` }
  if (!nativeWitnessIdentityMatches(witness, { generation: snapshot.generation, cwd: snapshot.cwd })) {
    return { proven: false, reason: '启动见证与当前 runner 身份不一致' }
  }
  if (projectCwd && !samePath(witness.cwd, projectCwd)) {
    return { proven: false, reason: '启动见证目录不是服务所属项目目录' }
  }
  for (const name of names) {
    if (witness.servers.includes(name)) return { proven: false, reason: `启动见证的配置里仍含「${name}」` }
  }
  return { proven: true, reason: '启动时未加载目标服务，且文件与身份均已复核' }
}

function samePath(a: string, b: string): boolean {
  return a.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase() ===
    b.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
}

export interface McpAppRuntimeProject {
  id: string
  cwd: string
}

export interface McpAppRuntimeOwnershipOptions {
  /** 当前 RunnerRegistry；返回 null = 注册表不可用，`holdersFor` 抛错由上层拒绝。 */
  registry: () => RunnerRegistry | null
  /** pi agent 目录（全局 `mcp.json` 所在）。缺省 = 无法核对，守卫拒绝。 */
  agentDir: string | (() => string | undefined)
  /** 受信项目登记；获取异常向上抛，由守卫折算成拒绝。 */
  projects: () => Promise<readonly McpAppRuntimeProject[]> | readonly McpAppRuntimeProject[]
  /** 读 pi 原生配置文本；缺省 fs（只把 ENOENT 当不存在）。 */
  readNativeConfig?: McpNativeConfigReader
  /** 读砚配置（取保存的原生原名）。缺省 `loadMcpServers`。 */
  readHostServers?: () => readonly McpAppServerConfig[]
  now?: () => number
}

function toOwnershipProjects(projects: readonly McpAppRuntimeProject[] | undefined): McpAppOwnershipProject[] {
  return (projects ?? [])
    .filter(
      (project): project is McpAppRuntimeProject =>
        Boolean(project && typeof project.id === 'string' && project.id.trim() && typeof project.cwd === 'string' && project.cwd.trim())
    )
    .map((project) => ({ id: project.id.trim(), cwd: project.cwd.trim() }))
}

/**
 * 构造给 `configureMcpAppHostOwnership` 的动态事实源。
 *
 * 事实每次求值：项目登记 / runner 集合 / 原生文件都会变，不能缓存结论。
 * `projects()` 抛错或注册表缺失都会让守卫拒绝连接（不把异常当空数组）。
 */
export function createMcpAppRuntimeOwnershipFacts(
  options: McpAppRuntimeOwnershipOptions
): () => Promise<McpAppOwnershipFacts> {
  const readHostServers = options.readHostServers ?? (() => loadMcpServers().servers)

  const holdersFor = async (query: McpAppRuntimeHolderQuery): Promise<readonly McpAppRuntimeHolder[]> => {
    const registry = options.registry()
    if (!registry) throw new Error('运行实例注册表不可用，无法确认旧 pi 是否已退出')

    let snapshots: McpHolderSnapshot[]
    try {
      snapshots = registry.mcpHolderSnapshots()
    } catch (error) {
      throw new Error(`读取运行实例快照失败，无法确认旧 pi 是否已退出：${error instanceof Error ? error.message : String(error)}`)
    }

    /* 目标名字：砚 id + 保存的原生原名；取配置失败也只是少了别名证据，不会更宽。 */
    let config: McpAppServerConfig | undefined
    try {
      config = readHostServers().find((server) => server.id === query.serverId)
    } catch {
      config = undefined
    }
    const names = mcpAppHolderNames(query.serverId, config)

    /* 项目服务的项目目录：拿不到就一律按可能持有。 */
    let projectCwd: string | undefined
    if (query.scope === 'project' && query.projectId) {
      try {
        const projects = await options.projects()
        projectCwd = toOwnershipProjects(projects).find((project) => project.id === query.projectId)?.cwd
      } catch {
        projectCwd = undefined
      }
    }

    const holders: McpAppRuntimeHolder[] = []
    for (const snapshot of snapshots) {
      if (!mayHoldMcpAppWithLegacy(snapshot, query)) continue

      /* 项目服务拿不到所属项目目录：无法证明见证目录正确，一律按可能持有。 */
      if (query.scope === 'project' && query.projectId && !projectCwd) {
        holders.push({ id: snapshot.runnerId, label: `${snapshot.runnerId}#${snapshot.generation}` })
        continue
      }

      const witness = snapshot.nativeWitness ?? null
      const pure = witnessProvesAbsent({
        witness,
        snapshot,
        names,
        ...(projectCwd ? { projectCwd } : {})
      })
      if (pure.proven) {
        const verified = await verifyNativeStartupWitness(witness!, {
          ...(options.readNativeConfig ? { readNativeConfig: options.readNativeConfig } : {})
        })
        if (verified.ok) continue
      }
      holders.push({ id: snapshot.runnerId, label: `${snapshot.runnerId}#${snapshot.generation}` })
    }
    return holders
  }

  return async () => {
    const agentDir = typeof options.agentDir === 'function' ? options.agentDir() : options.agentDir
    /* 项目登记求值异常直接向上抛：守卫会折算成 runtime-unknown 拒绝，不当作空数组。 */
    const projects = await options.projects()
    return {
      ...(typeof agentDir === 'string' && agentDir.trim() ? { agentDir: agentDir.trim() } : {}),
      projects: toOwnershipProjects(projects),
      ...(options.readNativeConfig ? { readNativeConfig: options.readNativeConfig } : {}),
      holdersFor
    }
  }
}
