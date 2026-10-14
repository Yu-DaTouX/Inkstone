/**
 * 能力页的 IPC 适配（`yan:capabilities:*`、`yan:search:doctor`）。
 *
 * 初次打开只取 pi 已加载的 Skill 与本运行实例可见的 MCP 配置；不握手、不启动 stdio。
 * MCP 验证由主进程分配 operationId 并固定到 runnerId + generation，渲染端不能指定项目。
 */
import type { IpcRegistrar } from './registrar'
import { installOpenCli, searchDoctor } from '../search/opencli'
import { clearSearchKey, searchApiConfig, setSearchHintDismissed, setSearchKey } from '../search/config'
import { isSearchProviderId } from '../../shared/search'
import { computerUseStatus, disableComputerUse, enableComputerUse, installUv } from '../computer-use'
import { randomUUID } from 'node:crypto'
import { builtinCapabilities } from '../extensions-inventory'
import type { AppSettings } from '../../shared/ipc'
import type { AgentController } from '../agent'
import type { RunnerRegistry } from '../runners'
import { PI_AGENT_DIR } from '../paths'
import { loadMcpServers, mcpServersForProject } from '../mcp/config'
import { createNativeMcpVerifier } from '../mcp/native-verify'
import {
  commitNativeMcpImport,
  NativeMcpImportError,
  prepareNativeMcpImport,
  sameNativeMcpImportRuntime
} from '../mcp/native-import'
import type { NativeMcpImportRuntimeIdentity } from '../mcp/native-import'
import { WINDOWS_MCP_SERVER_ID } from '../../shared/mcp-native-import'

type CapabilityVerification = {
  operationId: string
  runnerId: string
  generation: number
  agent: AgentController
  serverId: string
  state: 'connecting' | 'ready' | 'error' | 'cancelled' | 'stale'
  toolCount?: number
  updatedAt: number
}
/** UI 只持有不可预测的 operationId；runner 身份 / generation 始终由主进程绑定。 */
const capabilityVerifications = new Map<string, CapabilityVerification>()

function pruneCapabilityVerifications(): void {
  const cutoff = Date.now() - 5 * 60_000
  for (const [id, operation] of capabilityVerifications) {
    if (operation.updatedAt < cutoff && operation.state !== 'connecting') capabilityVerifications.delete(id)
  }
}

export interface CapabilitiesIpcDeps {
  /** 当前前台运行实例的控制器 */
  currentAgent(): AgentController | undefined
  registry(): RunnerRegistry | null
  /** 随包薄扩展的实际加载路径（与 pi 启动参数同源） */
  thinExtensionPaths(): string[]
  /** 受信设置：项目登记与 piBin 覆盖只从这里取，渲染端不能指定目录。 */
  settings(): Promise<AppSettings>
  /** 目录是否被 pi 信任（复用既有 trust API，不自行推测）。 */
  isProjectTrusted(cwd: string): Promise<boolean>
}

/**
 * 导入令牌与运行实例身份的绑定。令牌里的 `owner` 由本进程生成，渲染端只能回传令牌；
 * 提交前重新核对仍是同一个 runner / generation / 控制器 / 项目身份。
 */
interface NativeImportBinding {
  identity: NativeMcpImportRuntimeIdentity
  agent: AgentController
  ownerId: string
  serverId: string
  createdAt: number
}
const nativeImportBindings = new Map<string, NativeImportBinding>()
const NATIVE_IMPORT_BINDING_TTL_MS = 5 * 60_000

function pruneNativeImportBindings(): void {
  const cutoff = Date.now() - NATIVE_IMPORT_BINDING_TTL_MS
  for (const [token, binding] of nativeImportBindings) {
    if (binding.createdAt < cutoff) nativeImportBindings.delete(token)
  }
}

function nativeImportErrorResponse(error: unknown): { ok: false; code: string; error: string } {
  if (error instanceof NativeMcpImportError) return { ok: false, code: error.code, error: error.message }
  return { ok: false, code: 'native_import_failed', error: error instanceof Error ? error.message : String(error) }
}

export function registerCapabilitiesIpc(ipc: IpcRegistrar, deps: CapabilitiesIpcDeps): void {
  const { handle } = ipc
  const { currentAgent, registry, thinExtensionPaths, settings, isProjectTrusted } = deps
  /*
   * 受信内置能力清单（实施-02 S4）：设置页要用它与「用户装的插件」分开。
   * 只读，且与 pi 实际加载的路径同源 —— 不缓存，免得用户换了安装形态
   *（开发态 ↔ 打包态）后看到一份过期的清单。
   */
  handle('yan:capabilities:builtin', async () => builtinCapabilities(thinExtensionPaths()))

  /*
   * 搜索后端诊断（实施-27 S3/D4）：设置页要看 OpenCLI 在不在、扩展连没连。
   * 只读探针，不装不升级；未安装时也返回可读结果（available:false）。
   */
  handle('yan:search:doctor', async () => searchDoctor())
  /* 用户在设置页明确点了「安装」才会跑（npm 全局安装 OpenCLI）；诊断本身仍然只读 */
  handle('yan:search:install', async () => installOpenCli())
  /* 搜索 API key：只在主进程落盘，渲染端拿不到明文 */
  handle('yan:search:apiConfig', async () => searchApiConfig())
  handle('yan:search:setApiKey', async (_e, provider: string, key: string) =>
    isSearchProviderId(provider) ? setSearchKey(provider, String(key ?? '')) : { ok: false, error: '不认识的搜索服务' }
  )
  handle('yan:search:clearApiKey', async (_e, provider: string) =>
    isSearchProviderId(provider) ? clearSearchKey(provider) : { ok: false, error: '不认识的搜索服务' }
  )
  handle('yan:search:setApiHintDismissed', async (_e, dismissed: boolean) => setSearchHintDismissed(dismissed === true))

  /*
   * 电脑操作（Windows-MCP，见 computer-use.ts）：状态只读；安装 uv 与开关都要用户在设置页点。
   * 开关改的是宿主 MCP 配置，改完让所有实例丢掉旧连接。
   */
  handle('yan:computerUse:status', async () => computerUseStatus())
  handle('yan:computerUse:installUv', async () => installUv())
  handle('yan:computerUse:set', async (value: unknown) => {
    const result = value === true ? await enableComputerUse() : await disableComputerUse()
    if (result.ok) await registry()?.reloadMcpServers()
    return result
  })

  /*
   * 能力页初次打开只取 pi 已加载的 Skill 与本 runner 可见的 MCP 配置；不握手、不启动 stdio。
   * 验证操作由主进程分配 operationId 并固定到 runnerId + generation，渲染端不能指定项目。
   */
  handle('yan:capabilities:settings', async () => {
    const agent = currentAgent()
    return agent ? agent.capabilitySettingsSnapshot() : { skills: [], servers: [], configWarning: false }
  })
  /* 本次会话技能：保留到「我的技能」或移除；名字只在当前会话 index 里查，不接受路径。 */
  handle('yan:capabilities:sessionSkill', async (value: unknown) => {
    const input = value && typeof value === 'object' ? (value as { action?: unknown; name?: unknown }) : {}
    const action = input.action === 'promote' || input.action === 'remove' ? input.action : null
    const name = typeof input.name === 'string' ? input.name.trim().slice(0, 64) : ''
    if (!action || !name) return { ok: false, error: '参数无效' }
    const agent = currentAgent()
    return agent ? agent.sessionSkillAction(action, name) : { ok: false, error: '当前没有可用的运行实例' }
  })
  handle('yan:capabilities:discover', async (value: unknown) => {
    const queryText = typeof value === 'string' ? value.slice(0, 500) : ''
    const agent = currentAgent()
    if (!agent) return { query: '', reason: '当前没有可用的运行实例', sources: [], candidates: [] }
    try {
      return await agent.discoverCapabilitiesForSettings(queryText)
    } catch {
      return {
        query: '',
        reason: 'unavailable',
        sources: [],
        candidates: []
      }
    }
  })
  handle('yan:capabilities:verify', async (value: unknown) => {
    const serverId = typeof value === 'string' ? value.trim() : ''
    if (!serverId) return { ok: false, error: '缺少 MCP 服务 ID' }
    const agent = currentAgent()
    const runner = registry()?.activeRunner()
    const runtime = runner ? registry()?.runtimeOf(runner.id) : null
    if (!agent || !runner || !runtime) return { ok: false, error: '当前没有可验证的运行实例' }
    pruneCapabilityVerifications()
    if ([...capabilityVerifications.values()].filter((op) => op.state === 'connecting').length >= 8) {
      return { ok: false, error: '同时验证的 MCP 服务过多，请稍后再试' }
    }
    const operationId = randomUUID()
    const operation: CapabilityVerification = {
      operationId,
      runnerId: runner.id,
      generation: runtime.generation,
      agent,
      serverId,
      state: 'connecting',
      updatedAt: Date.now()
    }
    capabilityVerifications.set(operationId, operation)
    void agent.verifyCapabilityMcp(serverId).then(
      (result) => {
        if (operation.state === 'cancelled') return
        const current = registry()?.runtimeOf(operation.runnerId)
        if (!current || current.generation !== operation.generation || registry()?.agentOf(operation.runnerId) !== agent) {
          operation.state = 'stale'
        } else {
          operation.state = result.status === 'ready' ? 'ready' : 'error'
          operation.toolCount = result.toolCount
        }
        operation.updatedAt = Date.now()
      },
      () => {
        if (operation.state !== 'cancelled') operation.state = 'error'
        operation.updatedAt = Date.now()
      }
    )
    return { ok: true, operationId }
  })
  handle('yan:capabilities:verification', async (value: unknown) => {
    const operationId = typeof value === 'string' ? value : ''
    pruneCapabilityVerifications()
    const operation = capabilityVerifications.get(operationId)
    if (!operation) return null
    const current = registry()?.runtimeOf(operation.runnerId)
    if (operation.state === 'connecting' && (!current || current.generation !== operation.generation || registry()?.agentOf(operation.runnerId) !== operation.agent)) {
      operation.state = 'stale'
      operation.updatedAt = Date.now()
    }
    return {
      operationId,
      state: operation.state,
      ...(operation.toolCount !== undefined ? { toolCount: operation.toolCount } : {})
    }
  })
  handle('yan:capabilities:cancelVerification', async (value: unknown) => {
    const operation = capabilityVerifications.get(typeof value === 'string' ? value : '')
    if (!operation || operation.state !== 'connecting') return { ok: false, error: '验证已结束或不存在' }
    const current = registry()?.runtimeOf(operation.runnerId)
    if (!current || current.generation !== operation.generation || registry()?.agentOf(operation.runnerId) !== operation.agent) {
      operation.state = 'stale'
      operation.updatedAt = Date.now()
      return { ok: false, error: '运行实例已切换，未对新实例执行断开操作' }
    }
    const disconnected = await operation.agent.disconnectCapabilityMcp(operation.serverId)
    operation.state = disconnected ? 'cancelled' : 'stale'
    operation.updatedAt = Date.now()
    return { ok: disconnected, ...(disconnected ? {} : { error: 'MCP 服务已不存在' }) }
  })

  /*
   * 旧宿主 MCP 导入 pi 原生（方案合集 06）：prepare 只读预览并生成令牌，不落盘、
   * 不连接；commit 只在用户确认后由主窗口调用，且重核仍是同一运行实例。
   * 模型侧没有对应 `yan mcp import` 命令，模型不能直接提交。
   */
  const nativeImportHost = async (runnerCwd: string) => {
    const current = await settings()
    return {
      agentDir: PI_AGENT_DIR,
      projects: current.projects.map((project) => ({ id: project.id, cwd: project.cwd })),
      verify: createNativeMcpVerifier({
        ...(current.piBin ? { piBin: current.piBin } : {}),
        runnerCwd,
        isProjectTrusted
      })
    }
  }

  handle('yan:capabilities:prepareNativeImport', async (value: unknown) => {
    const serverId = typeof value === 'string' ? value.trim() : ''
    if (!serverId) return { ok: false, code: 'server_required', error: '缺少 MCP 服务 ID' }
    const agent = currentAgent()
    const runner = registry()?.activeRunner()
    const runtime = runner ? registry()?.runtimeOf(runner.id) : null
    if (!agent || !runner || !runtime) return { ok: false, code: 'no_runner', error: '当前没有可用的运行实例' }
    if (serverId === WINDOWS_MCP_SERVER_ID) {
      return { ok: false, code: 'windows_mcp_preserved', error: 'windows-mcp 保留在砚的连接里（电脑操作），不导入 pi 原生' }
    }
    /*
     * 服务必须在**该 runner 可见**的配置里：项目范围服务只属于其项目实例，
     * 不能从别的项目的 runner 导入；渲染端不能指定 owner / cwd / 路径。
     */
    const loaded = loadMcpServers()
    if (loaded.error) return { ok: false, code: 'host_config_invalid', error: `砚的 MCP 配置存在解析问题：${loaded.error}` }
    const projectId = agent.capabilityProjectId
    const visible = mcpServersForProject(loaded.servers, projectId ?? undefined).some((server) => server.id === serverId)
    if (!visible) {
      return { ok: false, code: 'server_not_visible', error: '该服务不在当前运行实例可见的 MCP 配置里，不能从本实例导入' }
    }
    const ownerId = `${runner.id}#${runtime.generation}`
    try {
      const host = await nativeImportHost(runner.cwd)
      const preview = await prepareNativeMcpImport({ host, serverId, owner: { id: ownerId } })
      pruneNativeImportBindings()
      nativeImportBindings.set(preview.token, {
        identity: { runnerId: runner.id, generation: runtime.generation, cwd: runner.cwd, projectId },
        agent,
        ownerId,
        serverId,
        createdAt: Date.now()
      })
      return { ok: true, preview }
    } catch (error) {
      return nativeImportErrorResponse(error)
    }
  })

  handle('yan:capabilities:commitNativeImport', async (value: unknown) => {
    const token = typeof value === 'string' ? value.trim() : ''
    if (!token) return { ok: false, code: 'token_required', error: '缺少导入令牌' }
    pruneNativeImportBindings()
    const binding = nativeImportBindings.get(token)
    if (!binding) return { ok: false, code: 'token_invalid', error: '导入令牌无效或已被使用，请重新预览' }
    const runner = registry()?.activeRunner()
    const runtime = runner ? registry()?.runtimeOf(runner.id) : null
    const agent = registry()?.agentOf(binding.identity.runnerId)
    if (!runner || !runtime || !agent || agent !== binding.agent) {
      nativeImportBindings.delete(token)
      return { ok: false, code: 'runner_changed', error: '运行实例或项目已切换，导入令牌作废，请重新预览' }
    }
    const after: NativeMcpImportRuntimeIdentity = {
      runnerId: runner.id,
      generation: runtime.generation,
      cwd: runner.cwd,
      projectId: agent.capabilityProjectId ?? null
    }
    if (!sameNativeMcpImportRuntime(binding.identity, after)) {
      nativeImportBindings.delete(token)
      return { ok: false, code: 'runner_changed', error: '运行实例或项目已切换，导入令牌作废，请重新预览' }
    }
    nativeImportBindings.delete(token)
    try {
      const host = await nativeImportHost(binding.identity.cwd)
      /*
       * `settings()` 是 await；期间运行实例可能已切换。提交前再核对一次当前身份，
       * 避免把新实例的宿主身份写到旧令牌上（不新建任务/授权状态）。
       */
      const runnerNow = registry()?.activeRunner()
      const runtimeNow = runnerNow ? registry()?.runtimeOf(runnerNow.id) : null
      const agentNow = registry()?.agentOf(binding.identity.runnerId)
      if (!runnerNow || !runtimeNow || !agentNow || agentNow !== binding.agent) {
        return { ok: false, code: 'runner_changed', error: '运行实例或项目已切换，导入令牌作废，请重新预览' }
      }
      const afterHost: NativeMcpImportRuntimeIdentity = {
        runnerId: runnerNow.id,
        generation: runtimeNow.generation,
        cwd: runnerNow.cwd,
        projectId: agentNow.capabilityProjectId ?? null
      }
      if (!sameNativeMcpImportRuntime(binding.identity, afterHost)) {
        return { ok: false, code: 'runner_changed', error: '运行实例或项目已切换，导入令牌作废，请重新预览' }
      }
      const result = await commitNativeMcpImport({ host, token, owner: { id: binding.ownerId } })
      /*
       * 成功后只断旧连接（旧 manager），不重启 pi；原生配置由 pi 自己在下一次加载时接管。
       * 重载失败不能改写成「导入失败/没写入」：写盘与停用已按分步结果发生，只如实附加旧连接没刷新的警告。
       */
      if (result.ok) {
        try {
          await registry()?.reloadMcpServers()
        } catch (error) {
          return {
            ok: true,
            result: {
              ...result,
              warnings: [
                ...result.warnings,
                `服务已导入原生并停用旧条目，但旧连接刷新失败：${error instanceof Error ? error.message : String(error)}；不会自动重启 runner，需下次实例加载时才生效`
              ]
            }
          }
        }
      }
      return { ok: true, result }
    } catch (error) {
      return nativeImportErrorResponse(error)
    }
  })
}
