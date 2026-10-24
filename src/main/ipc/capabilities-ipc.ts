import type { IpcRegistrar } from './registrar'
import { installOpenCli, searchDoctor } from '../search/opencli'
import { clearSearchKey, searchApiConfig, setSearchHintDismissed, setSearchKey } from '../search/config'
import { isSearchProviderId } from '../../shared/search'
import { computerUseStatus, disableComputerUse, enableComputerUse, installUv, resolveComputerUseInteraction } from '../computer-use'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { shell } from 'electron'
import { setManagedSkillEnabled, trashManagedSkill } from '../skill-manager'
import { builtinCapabilities } from '../extensions-inventory'
import type { AppSettings, PromptTemplateDirectories } from '../../shared/ipc'
import type { AgentController } from '../agent'
import type { RunnerRegistry } from '../runners'
import { PI_AGENT_DIR } from '../paths'
import { mergeCommandDescriptors } from '../command-registry'
import { loadMcpServers, mcpServersForProject } from '../mcp/config'
import { createNativeMcpVerifier } from '../mcp/native-verify'
import { listNativeMcpServers } from '../mcp/native-list'
import { manageNativeMcpServer } from '../mcp/native-manage'
import { changeMcpServiceSettings, listMcpServiceSettings, type McpSettingsHost } from '../mcp/service-settings'
import { verifyNativeStartupWitness } from '../mcp/app-native-witness'
import { mcpAppProxyService } from '../mcp/app-proxy-service'
import { validateNativeSessionRequest } from '../native-session-guard'
import type { McpSettingsMutation } from '../../shared/mcp-settings'
import type { NativeMcpServerListView } from '../../shared/mcp-native-import'
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
  handle('yan:search:setApiKey', async (provider: unknown, key: unknown) =>
    isSearchProviderId(provider) ? setSearchKey(provider, String(key ?? '')) : { ok: false, error: '不认识的搜索服务' }
  )
  handle('yan:search:clearApiKey', async (provider: unknown) =>
    isSearchProviderId(provider) ? clearSearchKey(provider) : { ok: false, error: '不认识的搜索服务' }
  )
  handle('yan:search:setApiHintDismissed', async (dismissed: unknown) => setSearchHintDismissed(dismissed === true))

  handle('yan:computerUse:status', async () => computerUseStatus())
  handle('yan:computerUse:installUv', async () => installUv())
  handle('yan:computerUse:resolveInteraction', async () => {
    resolveComputerUseInteraction()
    return computerUseStatus()
  })
  handle('yan:computerUse:set', async (value: unknown) => {
    const result = value === true ? await enableComputerUse() : await disableComputerUse()
    if (result.ok) await registry()?.reloadMcpServers()
    return result
  })

  const currentNativeMcpList = async (): Promise<NativeMcpServerListView> => {
    const projectCwd = registry()?.activeRunner()?.cwd
    const projectTrusted = projectCwd ? await isProjectTrusted(projectCwd).catch(() => false) : false
    return listNativeMcpServers({ agentDir: PI_AGENT_DIR, ...(projectCwd ? { projectCwd, projectTrusted } : {}) })
  }
  handle('yan:capabilities:nativeMcpServers', currentNativeMcpList)
  const mcpContext = (): string => {
    const runner = registry()?.activeRunner()
    const state = currentAgent()?.getState()
    return JSON.stringify([runner?.id, state?.sessionId, runner?.cwd, currentAgent()?.capabilityProjectId, runner ? registry()?.runtimeOf(runner.id)?.generation : undefined])
  }
  const mcpSettingsHost = async (): Promise<McpSettingsHost> => {
    const context = mcpContext()
    const agent = currentAgent()
    const runner = registry()?.activeRunner()
    const st = await settings()
    const project = st.projects.find((entry) => entry.id === agent?.capabilityProjectId)
    const projectTrusted = project && runner ? await isProjectTrusted(runner.cwd).catch(() => false) : false
    const witness = agent?.nativeBootWitness()
    const nativeConfigChanged = witness ? !(await verifyNativeStartupWitness(witness)).ok : null
    const busy = (): boolean => registry()?.agents().some((item) => {
      const state = item.getState()
      return !!(state?.isAgentRunning || state?.isStreaming || state?.isCompacting || state?.pendingMessageCount || item.hasRunningBash() || item.getPendingUiCount())
    }) ?? false
    if (context !== mcpContext()) throw new Error('当前会话或项目已切换，请重新读取')
    return {
      agentDir: PI_AGENT_DIR, context,
      project: project && runner ? { id: project.id, name: project.name, cwd: runner.cwd } : null,
      projectTrusted, projects: st.projects, nativeConfigChanged,
      busy: busy(), isBusy: busy,
      assertContext: () => { if (context !== mcpContext()) throw new Error('当前会话或项目已切换，请重新读取') }
    }
  }
  handle('yan:capabilities:mcpServices', async () => listMcpServiceSettings(await mcpSettingsHost()))
  handle('yan:capabilities:changeMcpService', async (input: McpSettingsMutation) => {
    const host = await mcpSettingsHost()
    const result = await changeMcpServiceSettings(host, input)
    return result
  })
  const mcpApplications = new WeakSet<AgentController>()
  handle('yan:capabilities:applyMcpServices', async (input: { context?: unknown; expectedSessionId?: unknown }) => {
    const agent = currentAgent()
    if (!agent) return { ok: false, error: '当前没有可用的运行实例' }
    const context = mcpContext()
    const fresh = (): void => {
      if (!input || input.context !== context || context !== mcpContext() || currentAgent() !== agent) throw new Error('会话已切换，请重新读取服务列表')
      const check = validateNativeSessionRequest({ action: 'reload', expectedSessionId: input.expectedSessionId }, agent.getState(), agent.hasRunningBash() || agent.getPendingUiCount() > 0)
      if (!check.ok) throw new Error(check.error)
    }
    if (mcpApplications.has(agent)) return { ok: false, error: '当前会话正在应用 MCP 设置' }
    mcpApplications.add(agent)
    try {
      fresh()
      const result = await mcpAppProxyService().refresh({ callerProjectId: agent.capabilityProjectId ?? undefined, allowEmpty: true })
      fresh()
      if (!result.ok) throw new Error(result.errors.map((entry) => `${entry.serverId}: ${entry.error}`).join('\n') || result.error || '托管工具刷新失败')
      await agent.nativeReload()
      await agent.listCommands()
      return { ok: true }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
    finally { mcpApplications.delete(agent) }
  })
  handle('yan:capabilities:manageNativeMcpServer', async (value: unknown) =>
    manageNativeMcpServer(await currentNativeMcpList(), value)
  )

  handle('yan:capabilities:settings', async () => {
    const agent = currentAgent()
    return agent ? agent.capabilitySettingsSnapshot() : { skills: [], servers: [], configWarning: false }
  })
  const promptDirectories = (): PromptTemplateDirectories => {
    const cwd = registry()?.activeRunner()?.cwd
    return {
      user: join(PI_AGENT_DIR, 'prompts'),
      ...(cwd ? { project: join(cwd, '.pi', 'prompts') } : {})
    }
  }
  handle('yan:capabilities:promptDirectories', promptDirectories)
  handle('yan:capabilities:openPromptDirectory', async (value: unknown) => {
    if (typeof value !== 'string' || !Object.values(promptDirectories()).includes(value)) {
      return { ok: false, error: '模板目录无效或当前会话已切换，请刷新列表后重试' }
    }
    if (!isAbsolute(value) || /^[\\/]{2}/.test(value)) return { ok: false, error: '不支持此模板目录' }
    try {
      await mkdir(value, { recursive: true })
      const error = await shell.openPath(value)
      return error ? { ok: false, error } : { ok: true }
    } catch (cause) {
      return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
    }
  })
  handle('yan:capabilities:createPromptTemplate', async (value: unknown) => {
    const input = value && typeof value === 'object' && !Array.isArray(value)
      ? value as { name?: unknown; content?: unknown }
      : {}
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    const content = typeof input.content === 'string' ? input.content.trim() : ''
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) {
      return { ok: false, error: '名称需为 1–64 个英文、数字、- 或 _，首位为英文或数字，且不能使用系统保留名称' }
    }
    if (!content || content.length > 64_000 || content.includes('\0')) {
      return { ok: false, error: '提示词正文不能为空，不能包含空字符，且不能超过 64000 个字符' }
    }
    const directory = promptDirectories().user
    if (!isAbsolute(directory) || /^[\\/]{2}/.test(directory)) return { ok: false, error: '不支持此模板目录' }
    try {
      const commands = await currentAgent()?.listCommands() ?? mergeCommandDescriptors(undefined)
      if (commands.some(command => command.name.toLowerCase() === name.toLowerCase())) {
        return { ok: false, error: '该名称已被命令或模板使用，请换一个名称' }
      }
      const hasArguments = /\$(?:@|ARGUMENTS|\d+)|\$\{(?:@:\d+(?::\d+)?|(?:@|ARGUMENTS|\d+):-[^}]*)\}/.test(content)
      const description = JSON.stringify(content.split('\n', 1)[0].trim().slice(0, 120))
      const template = `---\ndescription: ${description}\n---\n\n${content}${hasArguments ? '' : '\n\n$@'}\n`
      const path = join(directory, `${name}.md`)
      await mkdir(directory, { recursive: true })
      await writeFile(path, template, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      return { ok: true, path }
    } catch (cause) {
      const error = (cause as NodeJS.ErrnoException)?.code === 'EEXIST'
        ? '同名模板文件已存在，请换一个名称；原文件未修改'
        : cause instanceof Error ? cause.message : String(cause)
      return { ok: false, error }
    }
  })
  handle('yan:capabilities:sessionSkill', async (value: unknown) => {
    const input = value && typeof value === 'object' ? (value as { action?: unknown; name?: unknown }) : {}
    const action = input.action === 'promote' || input.action === 'remove' ? input.action : null
    const name = typeof input.name === 'string' ? input.name.trim().slice(0, 64) : ''
    if (!action || !name) return { ok: false, error: '参数无效' }
    const agent = currentAgent()
    return agent ? agent.sessionSkillAction(action, name) : { ok: false, error: '当前没有可用的运行实例' }
  })
  handle('yan:capabilities:manageSkill', async (value: unknown) => {
    const input = value && typeof value === 'object' ? (value as { action?: unknown; scope?: unknown; dir?: unknown }) : {}
    const action = input.action === 'enable' || input.action === 'disable' || input.action === 'trash' ? input.action : null
    const scope = input.scope === 'yan' || input.scope === 'pi' ? input.scope : null
    const dir = typeof input.dir === 'string' ? input.dir.trim() : ''
    if (!action || !scope || !dir) return { ok: false, error: '参数无效' }
    try {
      return action === 'trash'
        ? await trashManagedSkill(scope, dir, (path) => shell.trashItem(path))
        : await setManagedSkillEnabled(scope, dir, action === 'enable')
    } catch (cause) {
      return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
    }
  })
  handle('yan:capabilities:revealSkill', async (value: unknown) => {
    const location = typeof value === 'string' ? value.trim() : ''
    if (!location || !isAbsolute(location) || basename(location).toLowerCase() !== 'skill.md' || !existsSync(location)) {
      return { ok: false, error: '没有找到技能文件' }
    }
    shell.showItemInFolder(location)
    return { ok: true }
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
