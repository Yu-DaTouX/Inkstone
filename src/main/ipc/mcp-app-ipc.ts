import type { IpcRegistrar } from './registrar'
import type { AppSettings } from '../../shared/ipc'
import type { AgentController } from '../agent'
import type { RunnerRegistry, McpHolderSnapshot } from '../runners'
import { PI_AGENT_DIR } from '../paths'
import { loadMcpServersCached, mcpServersForProject } from '../mcp/config'
import { mcpAppHost } from '../mcp/app-host'
import { createNativeMcpPresenceVerifier } from '../mcp/native-verify'
import {
  commitMcpAppSwitch,
  McpAppSwitchError,
  mcpAppOwnershipView,
  prepareMcpAppSwitch,
  type McpAppSwitchHolderProvider,
  type McpAppSwitchHost
} from '../mcp/host-switch'
import {
  sameNativeMcpImportRuntime,
  type NativeMcpImportRuntimeIdentity
} from '../mcp/native-import'
import { mayHoldMcpApp, mayHoldMcpAppWithLegacy, mcpAppHolderNames, witnessProvesAbsent } from '../mcp/app-runtime-ownership'
import { verifyNativeStartupWitness } from '../mcp/app-native-witness'
import type { McpAppSwitchHolder } from '../../shared/mcp-app-switch'
import type { McpAppServerConfig } from '../mcp/app-spec'
import { pick } from '../../shared/ui-lang'

export { mayHoldMcpApp, mayHoldMcpAppWithLegacy }

export interface McpAppIpcDeps {
  currentAgent(): AgentController | undefined
  registry(): RunnerRegistry | null
  settings(): Promise<AppSettings>
  isProjectTrusted(cwd: string): Promise<boolean>
}

interface McpAppSwitchBinding {
  identity: NativeMcpImportRuntimeIdentity
  agent: AgentController
  ownerId: string
  serverId: string
  createdAt: number
}

const switchBindings = new Map<string, McpAppSwitchBinding>()
const SWITCH_BINDING_TTL_MS = 5 * 60_000

function pruneSwitchBindings(): void {
  const cutoff = Date.now() - SWITCH_BINDING_TTL_MS
  for (const [token, binding] of switchBindings) {
    if (binding.createdAt < cutoff) switchBindings.delete(token)
  }
}

function switchErrorResponse(error: unknown): { ok: false; code: string; error: string } {
  if (error instanceof McpAppSwitchError) return { ok: false, code: error.code, error: error.message }
  return { ok: false, code: 'mcp_app_switch_failed', error: error instanceof Error ? error.message : String(error) }
}

export async function mcpAppHoldersFor(
  registry: RunnerRegistry | null,
  server: { serverId: string; scope: 'global' | 'project'; projectId?: string }
): Promise<McpAppSwitchHolder[]> {
  if (!registry) {
    throw new McpAppSwitchError('holders_unavailable', pick('运行实例注册表不可用，无法确认是否有实例持有该服务', 'Runtime registry unavailable; cannot confirm whether a runtime holds this server'))
  }
  let snapshots: McpHolderSnapshot[]
  try {
    snapshots = registry.mcpHolderSnapshots()
  } catch {
    throw new McpAppSwitchError('holders_unavailable', pick('读取运行实例快照失败，无法确认持有情况', 'Failed to read the runtime snapshot; cannot confirm holders'))
  }
  let config: McpAppServerConfig | undefined
  try {
    config = loadMcpServersCached().servers.find((entry) => entry.id === server.serverId)
  } catch {
    config = undefined
  }
  const names = mcpAppHolderNames(server.serverId, config)
  const holders: McpAppSwitchHolder[] = []
  for (const snapshot of snapshots) {
    if (!mayHoldMcpAppWithLegacy(snapshot, server)) continue
    const witness = snapshot.nativeWitness ?? null
    if (witness && witnessProvesAbsent({ witness, snapshot, names }).proven) {
      const verified = await verifyNativeStartupWitness(witness).catch(() => ({ ok: false }))
      if (verified.ok) continue
    }
    holders.push({ runnerId: snapshot.runnerId, generation: snapshot.generation, busy: snapshot.busy })
  }
  return holders
}

function makeHoldersProvider(deps: McpAppIpcDeps): McpAppSwitchHolderProvider {
  return {
    runtimeEpoch(): string {
      const registry = deps.registry()
      if (!registry) {
        throw new McpAppSwitchError('holders_unavailable', pick('运行实例注册表不可用，无法在写入前复核实例状态', 'Runtime registry unavailable; cannot recheck runtime state before writing'))
      }
      return registry.mcpRuntimeEpoch()
    },
    async holdersFor(server): Promise<McpAppSwitchHolder[]> {
      return mcpAppHoldersFor(deps.registry(), server)
    }
  }
}

function buildSwitchHost(
  deps: McpAppIpcDeps,
  settings: AppSettings,
  runnerCwd: string
): McpAppSwitchHost {
  return {
    agentDir: PI_AGENT_DIR,
    projects: settings.projects.map((project) => ({ id: project.id, cwd: project.cwd })),
    holders: makeHoldersProvider(deps),
    disconnectHost: async (serverId) => {
      await mcpAppHost().disconnect(serverId)
    },
    verify: createNativeMcpPresenceVerifier({
      ...(settings.piBin ? { piBin: settings.piBin } : {}),
      runnerCwd,
      isProjectTrusted: deps.isProjectTrusted
    })
  }
}

export function registerMcpAppIpc(ipc: IpcRegistrar, deps: McpAppIpcDeps): void {
  const { handle } = ipc
  const { currentAgent, registry, settings } = deps

  handle('yan:mcpApp:ownership', async () => {
    const loaded = loadMcpServersCached()
    if (loaded.error) return { servers: [], error: pick(`砚的 MCP 配置存在解析问题：${loaded.error}`, `The Inkstone MCP config has parse errors: ${loaded.error}`) }
    const agent = currentAgent()
    const projectId = agent?.capabilityProjectId ?? undefined
    const providers = makeHoldersProvider(deps)
    const visible = mcpServersForProject(loaded.servers, projectId)
    const views = await Promise.all(
      visible.map(async (config) => {
        const scope = config.projectScope ? ('project' as const) : ('global' as const)
        let holders: McpAppSwitchHolder[] = []
        let holdersUnknown = false
        try {
          holders = await providers.holdersFor({
            serverId: config.id,
            scope,
            ...(config.projectScope ? { projectId: config.projectScope } : {})
          })
        } catch {
          holdersUnknown = true
        }
        return mcpAppOwnershipView({
          config,
          holders,
          projectScoped: Boolean(config.projectScope),
          holdersUnknown
        })
      })
    )
    return { servers: views }
  })

  handle('yan:mcpApp:prepareSwitch', async (value: unknown) => {
    const serverId = typeof value === 'string' ? value.trim() : ''
    if (!serverId) return { ok: false, code: 'server_required', error: pick('缺少 MCP 服务 ID', 'Missing MCP server ID') }
    const registryNow = registry()
    const runner = registryNow?.activeRunner()
    const runtime = runner ? registryNow?.runtimeOf(runner.id) : null
    if (!runner || !runtime) return { ok: false, code: 'no_runner', error: pick('当前没有可用的运行实例', 'No runtime available') }
    const loaded = loadMcpServersCached()
    if (loaded.error) return { ok: false, code: 'host_config_invalid', error: pick(`砚的 MCP 配置存在解析问题：${loaded.error}`, `The Inkstone MCP config has parse errors: ${loaded.error}`) }
    const agent = currentAgent()
    if (!agent) return { ok: false, code: 'no_runner', error: pick('当前没有可用的运行实例', 'No runtime available') }
    const projectId = agent.capabilityProjectId ?? undefined
    const visible = mcpServersForProject(loaded.servers, projectId).some((server) => server.id === serverId)
    if (!visible) {
      return { ok: false, code: 'server_not_visible', error: pick('该服务不在当前运行实例可见的 MCP 配置里，不能从本实例切换', 'This server is not in the MCP config visible to this runtime; cannot switch from here') }
    }
    const ownerId = `${runner.id}#${runtime.generation}`
    try {
      const current = await settings()
      const host = buildSwitchHost(deps, current, runner.cwd)
      const preview = await prepareMcpAppSwitch({ host, serverId, owner: { id: ownerId } })
      pruneSwitchBindings()
      switchBindings.set(preview.token, {
        identity: { runnerId: runner.id, generation: runtime.generation, cwd: runner.cwd, projectId: projectId ?? null },
        agent,
        ownerId,
        serverId,
        createdAt: Date.now()
      })
      return { ok: true, preview }
    } catch (error) {
      return switchErrorResponse(error)
    }
  })

  handle('yan:mcpApp:commitSwitch', async (value: unknown) => {
    const token = typeof value === 'string' ? value.trim() : ''
    if (!token) return { ok: false, code: 'token_required', error: pick('缺少切换令牌', 'Missing switch token') }
    pruneSwitchBindings()
    const binding = switchBindings.get(token)
    if (!binding) return { ok: false, code: 'token_invalid', error: pick('切换令牌无效或已被使用，请重新预览', 'Switch token invalid or already used; preview again') }
    const registryNow = registry()
    const runner = registryNow?.activeRunner()
    const runtime = runner ? registryNow?.runtimeOf(runner.id) : null
    const agent = registryNow?.agentOf(binding.identity.runnerId)
    if (!runner || !runtime || !agent || agent !== binding.agent) {
      switchBindings.delete(token)
      return { ok: false, code: 'runner_changed', error: pick('运行实例或项目已切换，切换令牌作废，请重新预览', 'Runtime or project changed; token voided. Preview again') }
    }
    const after: NativeMcpImportRuntimeIdentity = {
      runnerId: runner.id,
      generation: runtime.generation,
      cwd: runner.cwd,
      projectId: agent.capabilityProjectId ?? null
    }
    if (!sameNativeMcpImportRuntime(binding.identity, after)) {
      switchBindings.delete(token)
      return { ok: false, code: 'runner_changed', error: pick('运行实例或项目已切换，切换令牌作废，请重新预览', 'Runtime or project changed; token voided. Preview again') }
    }
    switchBindings.delete(token)
    try {
      const current = await settings()
      const host = buildSwitchHost(deps, current, binding.identity.cwd)
      const runnerNow = registry()?.activeRunner()
      const runtimeNow = runnerNow ? registry()?.runtimeOf(runnerNow.id) : null
      const agentNow = registry()?.agentOf(binding.identity.runnerId)
      if (!runnerNow || !runtimeNow || !agentNow || agentNow !== binding.agent) {
        return { ok: false, code: 'runner_changed', error: pick('运行实例或项目已切换，切换令牌作废，请重新预览', 'Runtime or project changed; token voided. Preview again') }
      }
      const afterHost: NativeMcpImportRuntimeIdentity = {
        runnerId: runnerNow.id,
        generation: runtimeNow.generation,
        cwd: runnerNow.cwd,
        projectId: agentNow.capabilityProjectId ?? null
      }
      if (!sameNativeMcpImportRuntime(binding.identity, afterHost)) {
        return { ok: false, code: 'runner_changed', error: pick('运行实例或项目已切换，切换令牌作废，请重新预览', 'Runtime or project changed; token voided. Preview again') }
      }
      const result = await commitMcpAppSwitch({ host, token, owner: { id: binding.ownerId } })
      if (!result.ok) return { ok: true, result }
      await mcpAppHost().reconcile(binding.serverId).catch(() => undefined)
      return {
        ok: true,
        result: {
          ...result,
          warnings: [
            ...result.warnings,
            pick('配置已切换；为避免影响其它会话，未自动重载所有运行实例，新会话或手动重载 MCP 后生效。', 'Config switched. Runtimes were not reloaded to avoid affecting other sessions; takes effect in new sessions or after reloading MCP.')
          ]
        }
      }
    } catch (error) {
      return switchErrorResponse(error)
    }
  })
}
