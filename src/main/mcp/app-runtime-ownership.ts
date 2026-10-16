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

export function mayHoldMcpApp(
  snapshot: Pick<McpHolderSnapshot, 'processRunning' | 'conn' | 'projectId'>,
  server: { serverId: string; scope: 'global' | 'project'; projectId?: string }
): boolean {
  if (!snapshot.processRunning && snapshot.conn === 'exited') return false
  if (server.scope === 'global') return true
  if (snapshot.projectId) return snapshot.projectId === server.projectId
  return true
}

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

export function witnessProvesAbsent(input: {
  witness: McpNativeBootWitness | null | undefined
  snapshot: Pick<McpHolderSnapshot, 'generation' | 'cwd' | 'processRunning' | 'conn'>
  names: ReadonlySet<string>
  projectCwd?: string
}): { proven: boolean; reason: string } {
  const { witness, snapshot, names, projectCwd } = input
  if (!witness) return { proven: false, reason: '没有启动见证' }
  if (!snapshot.processRunning) return { proven: false, reason: '进程未确认存活' }
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
  registry: () => RunnerRegistry | null
  agentDir: string | (() => string | undefined)
  projects: () => Promise<readonly McpAppRuntimeProject[]> | readonly McpAppRuntimeProject[]
  readNativeConfig?: McpNativeConfigReader
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

    let config: McpAppServerConfig | undefined
    try {
      config = readHostServers().find((server) => server.id === query.serverId)
    } catch {
      config = undefined
    }
    const names = mcpAppHolderNames(query.serverId, config)

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
    const projects = await options.projects()
    return {
      ...(typeof agentDir === 'string' && agentDir.trim() ? { agentDir: agentDir.trim() } : {}),
      projects: toOwnershipProjects(projects),
      ...(options.readNativeConfig ? { readNativeConfig: options.readNativeConfig } : {}),
      holdersFor
    }
  }
}
