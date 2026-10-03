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
import type { AgentController } from '../agent'
import type { RunnerRegistry } from '../runners'

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
}

export function registerCapabilitiesIpc(ipc: IpcRegistrar, deps: CapabilitiesIpcDeps): void {
  const { handle } = ipc
  const { currentAgent, registry, thinExtensionPaths } = deps
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
}
