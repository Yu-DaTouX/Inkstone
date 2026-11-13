import { pick } from '../../shared/ui-lang'
import type { IpcRegistrar } from './registrar'
import { searchDoctor } from '../search/search'
import { clearSearchKey, searchApiConfig, setSearchHintDismissed, setSearchKey } from '../search/config'
import { isSearchProviderId } from '../../shared/search'
import { IMAGE_KEY_SERVICES, IMAGE_MODEL_SERVICES, type ImageConfigPatch, type ImageKeyService, type ImageModelService } from '../../shared/image-config'
import { clearImageKey, setImageKey, updateImageConfig } from '../image-config'
import { imageConfigView } from '../image-config-view'
import { computerUseStatus, disableComputerUse, enableComputerUse, installUv, refreshComputerUseEntry, resolveComputerUseInteraction } from '../computer-use'
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
import { listNativeMcpServers } from '../mcp/native-list'
import { manageNativeMcpServer } from '../mcp/native-manage'
import { changeMcpServiceSettings, listMcpServiceSettings, type McpSettingsHost } from '../mcp/service-settings'
import { verifyNativeStartupWitness } from '../mcp/app-native-witness'
import { mcpAppProxyService } from '../mcp/app-proxy-service'
import { validateNativeSessionRequest } from '../native-session-guard'
import type { McpSettingsMutation } from '../../shared/mcp-settings'
import type { NativeMcpServerListView } from '../../shared/mcp-native'

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

export function registerCapabilitiesIpc(ipc: IpcRegistrar, deps: CapabilitiesIpcDeps): void {
  const { handle } = ipc
  const { currentAgent, registry, thinExtensionPaths, settings, isProjectTrusted } = deps
  handle('yan:capabilities:builtin', async () => builtinCapabilities(thinExtensionPaths()))

  handle('yan:search:doctor', async () => searchDoctor())
  handle('yan:search:apiConfig', async () => searchApiConfig())
  handle('yan:search:setApiKey', async (provider: unknown, key: unknown) =>
    isSearchProviderId(provider) ? setSearchKey(provider, String(key ?? '')) : { ok: false, error: pick('不认识的搜索服务', 'Unknown search provider') }
  )
  handle('yan:search:clearApiKey', async (provider: unknown) =>
    isSearchProviderId(provider) ? clearSearchKey(provider) : { ok: false, error: pick('不认识的搜索服务', 'Unknown search provider') }
  )
  handle('yan:image:config', async () => imageConfigView())
  handle('yan:image:update', async (patch: unknown) => {
    const input = (patch && typeof patch === 'object' ? patch : {}) as Partial<ImageConfigPatch>
    const model = input.model && typeof input.model === 'object' && (IMAGE_MODEL_SERVICES as readonly string[]).includes(input.model.service as ImageModelService) && typeof input.model.value === 'string' ? { service: input.model.service as ImageModelService, value: input.model.value } : undefined
    return updateImageConfig({
      ...(typeof input.provider === 'string' ? { provider: input.provider } : {}),
      ...(typeof input.baseUrl === 'string' ? { baseUrl: input.baseUrl } : {}),
      ...(typeof input.complexity === 'string' ? { complexity: input.complexity } : {}),
      ...(model ? { model } : {})
    })
  })
  handle('yan:image:setKey', async (service: unknown, key: unknown) =>
    (IMAGE_KEY_SERVICES as readonly unknown[]).includes(service) ? setImageKey(service as ImageKeyService, String(key ?? '')) : { ok: false, error: pick('不认识的生图服务', 'Unknown image service') }
  )
  handle('yan:image:clearKey', async (service: unknown) =>
    (IMAGE_KEY_SERVICES as readonly unknown[]).includes(service) ? clearImageKey(service as ImageKeyService) : { ok: false, error: pick('不认识的生图服务', 'Unknown image service') }
  )
  handle('yan:search:setApiHintDismissed', async (dismissed: unknown) => setSearchHintDismissed(dismissed === true))

  void refreshComputerUseEntry()
    .then((changed) => (changed ? registry()?.reloadMcpServers() : undefined))
    .catch(() => undefined)
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
    if (context !== mcpContext()) throw new Error(pick('当前会话或项目已切换，请重新读取', 'Session or project changed; reload'))
    return {
      agentDir: PI_AGENT_DIR, context,
      project: project && runner ? { id: project.id, name: project.name, cwd: runner.cwd } : null,
      projectTrusted, projects: st.projects, nativeConfigChanged,
      busy: busy(), isBusy: busy,
      assertContext: () => { if (context !== mcpContext()) throw new Error(pick('当前会话或项目已切换，请重新读取', 'Session or project changed; reload')) }
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
    if (!agent) return { ok: false, error: pick('当前没有可用的运行实例', 'No runtime available') }
    const context = mcpContext()
    const fresh = (): void => {
      if (!input || input.context !== context || context !== mcpContext() || currentAgent() !== agent) throw new Error(pick('会话已切换，请重新读取服务列表', 'Session changed; reload the service list'))
      const check = validateNativeSessionRequest({ action: 'reload', expectedSessionId: input.expectedSessionId }, agent.getState(), agent.hasRunningBash() || agent.getPendingUiCount() > 0)
      if (!check.ok) throw new Error(check.error)
    }
    if (mcpApplications.has(agent)) return { ok: false, error: pick('当前会话正在应用 MCP 设置', 'This session is applying MCP settings') }
    mcpApplications.add(agent)
    try {
      fresh()
      const result = await mcpAppProxyService().refresh({ callerProjectId: agent.capabilityProjectId ?? undefined, allowEmpty: true })
      fresh()
      if (!result.ok) throw new Error(result.errors.map((entry) => `${entry.serverId}: ${entry.error}`).join('\n') || result.error || pick('托管工具刷新失败', 'Failed to refresh managed tools'))
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
      return { ok: false, error: pick('模板目录无效或当前会话已切换，请刷新列表后重试', 'Invalid template folder or session changed; refresh and retry') }
    }
    if (!isAbsolute(value) || /^[\\/]{2}/.test(value)) return { ok: false, error: pick('不支持此模板目录', 'Template folder not supported') }
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
      return { ok: false, error: pick('名称需为 1–64 个英文、数字、- 或 _，首位为英文或数字，且不能使用系统保留名称', 'Name must be 1–64 letters, digits, - or _, start with a letter or digit, and not be a reserved name') }
    }
    if (!content || content.length > 64_000 || content.includes('\0')) {
      return { ok: false, error: pick('提示词正文不能为空，不能包含空字符，且不能超过 64000 个字符', 'Prompt body must be non-empty, contain no null characters, and be at most 64000 characters') }
    }
    const directory = promptDirectories().user
    if (!isAbsolute(directory) || /^[\\/]{2}/.test(directory)) return { ok: false, error: pick('不支持此模板目录', 'Template folder not supported') }
    try {
      const commands = await currentAgent()?.listCommands() ?? mergeCommandDescriptors(undefined)
      if (commands.some(command => command.name.toLowerCase() === name.toLowerCase())) {
        return { ok: false, error: pick('该名称已被命令或模板使用，请换一个名称', 'Name is already used by a command or template') }
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
        ? pick('同名模板文件已存在，请换一个名称；原文件未修改', 'A template with this name already exists; the original is unchanged')
        : cause instanceof Error ? cause.message : String(cause)
      return { ok: false, error }
    }
  })
  handle('yan:capabilities:sessionSkill', async (value: unknown) => {
    const input = value && typeof value === 'object' ? (value as { action?: unknown; name?: unknown }) : {}
    const action = input.action === 'promote' || input.action === 'remove' ? input.action : null
    const name = typeof input.name === 'string' ? input.name.trim().slice(0, 64) : ''
    if (!action || !name) return { ok: false, error: pick('参数无效', 'Invalid arguments') }
    const agent = currentAgent()
    return agent ? agent.sessionSkillAction(action, name) : { ok: false, error: pick('当前没有可用的运行实例', 'No runtime available') }
  })
  handle('yan:capabilities:manageSkill', async (value: unknown) => {
    const input = value && typeof value === 'object' ? (value as { action?: unknown; scope?: unknown; dir?: unknown }) : {}
    const action = input.action === 'enable' || input.action === 'disable' || input.action === 'trash' ? input.action : null
    const scope = input.scope === 'yan' || input.scope === 'pi' ? input.scope : null
    const dir = typeof input.dir === 'string' ? input.dir.trim() : ''
    if (!action || !scope || !dir) return { ok: false, error: pick('参数无效', 'Invalid arguments') }
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
      return { ok: false, error: pick('没有找到技能文件', 'Skill file not found') }
    }
    shell.showItemInFolder(location)
    return { ok: true }
  })
  handle('yan:capabilities:discover', async (value: unknown) => {
    const queryText = typeof value === 'string' ? value.slice(0, 500) : ''
    const agent = currentAgent()
    if (!agent) return { query: '', reason: pick('当前没有可用的运行实例', 'No runtime available'), sources: [], candidates: [] }
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
    if (!serverId) return { ok: false, error: pick('缺少 MCP 服务 ID', 'Missing MCP service ID') }
    const agent = currentAgent()
    const runner = registry()?.activeRunner()
    const runtime = runner ? registry()?.runtimeOf(runner.id) : null
    if (!agent || !runner || !runtime) return { ok: false, error: pick('当前没有可验证的运行实例', 'No runtime available to verify') }
    pruneCapabilityVerifications()
    if ([...capabilityVerifications.values()].filter((op) => op.state === 'connecting').length >= 8) {
      return { ok: false, error: pick('同时验证的 MCP 服务过多，请稍后再试', 'Too many MCP services being verified; try again later') }
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
    if (!operation || operation.state !== 'connecting') return { ok: false, error: pick('验证已结束或不存在', 'Verification ended or does not exist') }
    const current = registry()?.runtimeOf(operation.runnerId)
    if (!current || current.generation !== operation.generation || registry()?.agentOf(operation.runnerId) !== operation.agent) {
      operation.state = 'stale'
      operation.updatedAt = Date.now()
      return { ok: false, error: pick('运行实例已切换，未对新实例执行断开操作', 'Runtime changed; the new runtime was not disconnected') }
    }
    const disconnected = await operation.agent.disconnectCapabilityMcp(operation.serverId)
    operation.state = disconnected ? 'cancelled' : 'stale'
    operation.updatedAt = Date.now()
    return { ok: disconnected, ...(disconnected ? {} : { error: pick('MCP 服务已不存在', 'MCP service no longer exists') }) }
  })
}
