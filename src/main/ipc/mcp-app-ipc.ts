/**
 * MCP 服务归属切换的 IPC 适配（`yan:mcpApp:*`）。
 *
 * 与 `capabilities-ipc.ts` 的导入入口同一套边界：只读归属视图不连接、不落盘；
 * `prepareSwitch` 只生成绑定运行实例身份的短效令牌；`commitSwitch` 只在用户确认后
 * 由主窗口调用，并在写盘前后重核仍是同一个 runner / generation / 控制器 / 项目。
 *
 * 调用者身份、宿主路径、运行时守卫与断开连接全部由主进程提供，渲染端只能回传令牌；
 * 原始 pi 条目与完整配置不进入任何响应。
 */
import type { IpcRegistrar } from './registrar'
import type { AppSettings } from '../../shared/ipc'
import type { AgentController } from '../agent'
import type { RunnerRegistry, McpHolderSnapshot } from '../runners'
import { PI_AGENT_DIR } from '../paths'
import { loadMcpServers, mcpServersForProject } from '../mcp/config'
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
import { mayHoldMcpApp, mayHoldMcpAppWithLegacy } from '../mcp/app-runtime-ownership'
import type { McpAppSwitchHolder } from '../../shared/mcp-app-switch'

/*
 * 保守范围闸门由 `mcp/app-runtime-ownership.ts` 统一提供（供 A7 宿主连接路径共用）：
 * 这里只 re-export，不各自维护一份口径。宿主连接的启动见证判定在 A7 facts 工厂里。
 * `mayHoldMcpAppWithLegacy` 额外并入 AgentController 侧 legacy 连接事实。
 */
export { mayHoldMcpApp, mayHoldMcpAppWithLegacy }

export interface McpAppIpcDeps {
  /** 当前前台运行实例的控制器 */
  currentAgent(): AgentController | undefined
  registry(): RunnerRegistry | null
  /** 受信设置：项目登记与 piBin 覆盖只从这里取，渲染端不能指定目录。 */
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

/**
 * 运行时守卫：基于 RunnerRegistry 的**内部窄快照**列出可能仍持有该服务的实例。
 *
 * 与旧实现的区别：不用 `statuses()`（会漏掉 hidden / 后台交接实例），也不用
 * `busy` 猜测存活状态；注册表缺失 / 读取异常一律抛错，由上层拒绝切换。
 * 返回值只含 id / generation / busy，不把实例全集推给渲染端。
 *
 * 注意：`to-inkstone` 切换保持**保守** —— 本函数只用 `mayHoldMcpAppWithLegacy`
 *（进程确定退出、已知其它项目、且 AgentController 侧 legacy 无该 server 才算排除），
 * 不拿 A7 启动见证放行；见证化排除只用于宿主连接路径，
 * 不给切换路径放宽旧 runner 阻断。
 */
export async function mcpAppHoldersFor(
  registry: RunnerRegistry | null,
  server: { serverId: string; scope: 'global' | 'project'; projectId?: string }
): Promise<McpAppSwitchHolder[]> {
  if (!registry) {
    throw new McpAppSwitchError('holders_unavailable', '运行实例注册表不可用，无法确认是否有实例持有该服务')
  }
  let snapshots: McpHolderSnapshot[]
  try {
    snapshots = registry.mcpHolderSnapshots()
  } catch {
    throw new McpAppSwitchError('holders_unavailable', '读取运行实例快照失败，无法确认持有情况')
  }
  return snapshots
    .filter((snapshot) => mayHoldMcpAppWithLegacy(snapshot, server))
    .map((snapshot) => ({
      runnerId: snapshot.runnerId,
      generation: snapshot.generation,
      busy: snapshot.busy
    }))
}

function makeHoldersProvider(deps: McpAppIpcDeps): McpAppSwitchHolderProvider {
  return {
    runtimeEpoch(): string {
      const registry = deps.registry()
      if (!registry) {
        throw new McpAppSwitchError('holders_unavailable', '运行实例注册表不可用，无法在写入前复核实例状态')
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
    /*
     * `to-pi` 写盘前确认唯一所有者：只断**该 server** 的宿主连接，
     * 不 close 整个连接池（其它 service / 会话不受影响）。
     */
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

  /* 只读归属视图：不连接、不落盘、不回传凭证。 */
  handle('yan:mcpApp:ownership', async () => {
    const loaded = loadMcpServers()
    if (loaded.error) return { servers: [], error: `砚的 MCP 配置存在解析问题：${loaded.error}` }
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
          /* 运行时无法判断：不把异常抛给渲染端，按 fail-closed 标为不可切换。 */
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
    if (!serverId) return { ok: false, code: 'server_required', error: '缺少 MCP 服务 ID' }
    const registryNow = registry()
    const runner = registryNow?.activeRunner()
    const runtime = runner ? registryNow?.runtimeOf(runner.id) : null
    if (!runner || !runtime) return { ok: false, code: 'no_runner', error: '当前没有可用的运行实例' }
    const loaded = loadMcpServers()
    if (loaded.error) return { ok: false, code: 'host_config_invalid', error: `砚的 MCP 配置存在解析问题：${loaded.error}` }
    const agent = currentAgent()
    if (!agent) return { ok: false, code: 'no_runner', error: '当前没有可用的运行实例' }
    const projectId = agent.capabilityProjectId ?? undefined
    const visible = mcpServersForProject(loaded.servers, projectId).some((server) => server.id === serverId)
    if (!visible) {
      return { ok: false, code: 'server_not_visible', error: '该服务不在当前运行实例可见的 MCP 配置里，不能从本实例切换' }
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
    if (!token) return { ok: false, code: 'token_required', error: '缺少切换令牌' }
    pruneSwitchBindings()
    const binding = switchBindings.get(token)
    if (!binding) return { ok: false, code: 'token_invalid', error: '切换令牌无效或已被使用，请重新预览' }
    const registryNow = registry()
    const runner = registryNow?.activeRunner()
    const runtime = runner ? registryNow?.runtimeOf(runner.id) : null
    const agent = registryNow?.agentOf(binding.identity.runnerId)
    if (!runner || !runtime || !agent || agent !== binding.agent) {
      switchBindings.delete(token)
      return { ok: false, code: 'runner_changed', error: '运行实例或项目已切换，切换令牌作废，请重新预览' }
    }
    const after: NativeMcpImportRuntimeIdentity = {
      runnerId: runner.id,
      generation: runtime.generation,
      cwd: runner.cwd,
      projectId: agent.capabilityProjectId ?? null
    }
    if (!sameNativeMcpImportRuntime(binding.identity, after)) {
      switchBindings.delete(token)
      return { ok: false, code: 'runner_changed', error: '运行实例或项目已切换，切换令牌作废，请重新预览' }
    }
    switchBindings.delete(token)
    try {
      const current = await settings()
      const host = buildSwitchHost(deps, current, binding.identity.cwd)
      /* `settings()` 是 await；期间运行实例可能已切换，提交前再核对一次。 */
      const runnerNow = registry()?.activeRunner()
      const runtimeNow = runnerNow ? registry()?.runtimeOf(runnerNow.id) : null
      const agentNow = registry()?.agentOf(binding.identity.runnerId)
      if (!runnerNow || !runtimeNow || !agentNow || agentNow !== binding.agent) {
        return { ok: false, code: 'runner_changed', error: '运行实例或项目已切换，切换令牌作废，请重新预览' }
      }
      const afterHost: NativeMcpImportRuntimeIdentity = {
        runnerId: runnerNow.id,
        generation: runtimeNow.generation,
        cwd: runnerNow.cwd,
        projectId: agentNow.capabilityProjectId ?? null
      }
      if (!sameNativeMcpImportRuntime(binding.identity, afterHost)) {
        return { ok: false, code: 'runner_changed', error: '运行实例或项目已切换，切换令牌作废，请重新预览' }
      }
      const result = await commitMcpAppSwitch({ host, token, owner: { id: binding.ownerId } })
      if (!result.ok) return { ok: true, result }
      /*
       * 归属切换后按**当前配置 + 当前事实**对该服务显式对账：不再合法的池连接断开，
       * 无关服务不动。不自动重启 / 批量 reload 用户会话。
       */
      await mcpAppHost().reconcile(binding.serverId).catch(() => undefined)
      /*
       * 不自动 `registry.reloadMcpServers()`：那会关闭**所有**运行实例的 MCP 连接，
       * 改变其它会话的运行状态，且无法证明无副作用。只如实提示需要新会话 / 手动重载。
       * FIX3 的连接资格自检独立 fail-closed，不依赖这里的即时重载。
       */
      return {
        ok: true,
        result: {
          ...result,
          warnings: [
            ...result.warnings,
            '配置已切换；为避免影响其它会话，未自动重载所有运行实例，新会话或手动重载 MCP 后生效。'
          ]
        }
      }
    } catch (error) {
      return switchErrorResponse(error)
    }
  })
}
