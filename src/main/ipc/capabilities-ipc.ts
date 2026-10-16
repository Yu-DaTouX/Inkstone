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
const capabilityVerifications = new Map<string, CapabilityVerification>()

function pruneCapabilityVerifications(): void {
  const cutoff = Date.now() - 5 * 60_000
  for (const [id, operation] of capabilityVerifications) {
    if (operation.updatedAt < cutoff && operation.state !== 'connecting') capabilityVerifications.delete(id)
  }
}

export interface CapabilitiesIpcDeps {
  currentAgent(): AgentController | undefined
  registry(): RunnerRegistry | null
  thinExtensionPaths(): string[]
  settings(): Promise<AppSettings>
  isProjectTrusted(cwd: string): Promise<boolean>
}

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
  handle('yan:capabilities:builtin', async () => builtinCapabilities(thinExtensionPaths()))

  handle('yan:search:doctor', async () => searchDoctor())
  handle('yan:search:install', async () => installOpenCli())
  handle('yan:search:apiConfig', async () => searchApiConfig())
  handle('yan:search:setApiKey', async (_e, provider: string, key: string) =>
    isSearchProviderId(provider) ? setSearchKey(provider, String(key ?? '')) : { ok: false, error: '不认识的搜索服务' }
  )
  handle('yan:search:clearApiKey', async (_e, provider: string) =>
    isSearchProviderId(provider) ? clearSearchKey(provider) : { ok: false, error: '不认识的搜索服务' }
  )
  handle('yan:search:setApiHintDismissed', async (_e, dismissed: boolean) => setSearchHintDismissed(dismissed === true))

  handle('yan:computerUse:status', async () => computerUseStatus())
  handle('yan:computerUse:installUv', async () => installUv())
  handle('yan:computerUse:set', async (value: unknown) => {
    const result = value === true ? await enableComputerUse() : await disableComputerUse()
    if (result.ok) await registry()?.reloadMcpServers()
    return result
  })

  handle('yan:capabilities:settings', async () => {
    const agent = currentAgent()
    return agent ? agent.capabilitySettingsSnapshot() : { skills: [], servers: [], configWarning: false }
  })
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
