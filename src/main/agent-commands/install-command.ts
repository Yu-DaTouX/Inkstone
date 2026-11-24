import { pick } from '../../shared/ui-lang'
import { UI_TIMEOUT_APPROVAL } from '../../shared/ui-timeout'
import type { McpSettingsMutation, McpSettingsResult, McpSettingsService, McpSettingsSnapshot } from '../../shared/mcp-settings'
import { CapabilityCommandError } from '../capability-server'
import { paramString } from '../command-params'
import { validatePackageSource, type PackageActionResult, type PackageListing } from '../packages'

export interface InstallPlugin {
  id: string
  name: string
  desc: string
  installed: boolean
}

export interface InstallProject {
  name: string
  trusted: boolean
}

export interface InstallServices {
  project(): Promise<InstallProject | null>
  mcpServices(): Promise<McpSettingsSnapshot>
  mcpChange(mutation: McpSettingsMutation): Promise<McpSettingsResult>
  plugins(): Promise<InstallPlugin[]>
  pluginAction(id: string, action: 'install' | 'remove'): Promise<{ ok: boolean; installed?: boolean; error?: string }>
  packages(): PackageListing
  packageAction(request: { kind: 'install' | 'remove'; source: string; local: boolean }): Promise<PackageActionResult>
  refresh(): void
}

export interface InstallApprovalRequest {
  title: string
  message: string
  options: string[]
  placeholder: string
  timeout: number
}

export interface InstallCommandHost {
  services(): InstallServices | undefined
  requestApproval(request: InstallApprovalRequest): Promise<{ value?: string; cancelled?: boolean }>
}

export const INSTALL_COMMANDS: ReadonlySet<string> = new Set([
  'mcp.services', 'mcp.add', 'mcp.remove', 'mcp.enable', 'mcp.disable',
  'plugin.list', 'plugin.install', 'plugin.remove',
  'package.list', 'package.install', 'package.remove'
])

export interface McpAddRequest {
  name: string
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  app?: boolean
  scope?: string
  reason?: string
  source?: string
}

type Approval = { kind: 'chosen'; choice: string } | { kind: 'declined'; reply?: string } | { kind: 'timeout' }

const ALLOW = (): string => pick('允许', 'Allow')
const ALL_SESSIONS = (): string => pick('添加到所有会话（全局）', 'Add for all sessions (global)')
const ALL_PROJECTS = (): string => pick('装到所有项目（全局）', 'Install for all projects (global)')
const ONLY_PROJECT = (name: string): string => pick(`只用于当前项目「${name}」`, `Only for the current project "${name}"`)

const APPLIED = (): string => pick(
  '已写入。当前会话会在这一轮结束后自动重启加载，从用户的下一条消息起可以用；其他空闲会话已同时刷新。告诉用户装好了什么、下一条消息起可用。',
  'Saved. This session restarts automatically after this turn and can use it from the user\'s next message; other idle sessions were refreshed too. Tell the user what was set up and that it works from their next message.'
)

function result(command: string, state: string, notice: string, extra: Record<string, unknown> = {}) {
  const [kind, action] = command.split('.')
  return { data: { state, notice, ...extra }, summary: { kind, action, state, ...extra } }
}

function notApproved(command: string, approval: Exclude<Approval, { kind: 'chosen' }>) {
  if (approval.kind === 'timeout') {
    return result(command, 'skipped', pick('用户没有在时限内批准，没有改动。不要再次请求同一项；在回复里说明需要用户决定什么。', 'The user did not approve in time; nothing changed. Do not ask again for the same item; say in your reply what the user needs to decide.'), { reason: 'timeout' })
  }
  if (approval.reply) {
    return result(command, 'skipped', pick('用户没有批准，而是回复了 userReply；按用户的话调整做法，没有改动任何东西。', 'The user did not approve and replied with userReply instead; adjust to what they said. Nothing changed.'), { reason: 'user-reply', userReply: approval.reply })
  }
  return result(command, 'skipped', pick('用户没有批准，没有改动。不要再次请求同一项。', 'The user did not approve; nothing changed. Do not ask again for the same item.'), { reason: 'declined' })
}

async function ask(host: InstallCommandHost, title: string, lines: Array<string | false | undefined>, options: string[]): Promise<Approval> {
  try {
    const answer = await host.requestApproval({
      title,
      message: lines.filter((line): line is string => typeof line === 'string' && line.length > 0).join('\n'),
      options,
      placeholder: pick('或告诉 Agent 换个做法（不改动）', 'Or tell the Agent to do it another way (no change)'),
      timeout: UI_TIMEOUT_APPROVAL
    })
    const value = answer.cancelled ? undefined : answer.value?.trim()
    if (value && options.includes(value)) return { kind: 'chosen', choice: value }
    return value ? { kind: 'declined', reply: value } : { kind: 'declined' }
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'question_timeout') return { kind: 'timeout' }
    throw error
  }
}

function usage(message: string): never {
  throw new CapabilityCommandError('install_bad_request', message)
}

function stringList(value: unknown, label: string): string[] | undefined {
  if (value === undefined || value === null || value === true) return undefined
  const list = Array.isArray(value) ? value : [value]
  if (!list.every((item) => typeof item === 'string')) usage(pick(`${label} 必须是字符串`, `${label} must be strings`))
  return list as string[]
}

export function envOf(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null || value === true) return undefined
  if (typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>)
    if (!entries.every(([, v]) => typeof v === 'string')) usage(pick('env 的值必须是字符串', 'env values must be strings'))
    return entries.length ? Object.fromEntries(entries) as Record<string, string> : undefined
  }
  const env: Record<string, string> = {}
  for (const item of stringList(value, 'env') ?? []) {
    const eq = item.indexOf('=')
    if (eq <= 0) usage(pick(`env 要写成 名字=值：${item.split('=')[0]}`, `env must be NAME=value: ${item.split('=')[0]}`))
    env[item.slice(0, eq)] = item.slice(eq + 1)
  }
  return Object.keys(env).length ? env : undefined
}

export function mcpAddRequestOf(params: Record<string, unknown>): McpAddRequest {
  const name = paramString(params, ['name', 'server', 'serverId'])
  if (!name) usage(pick('需要 --name <服务名>', 'Needs --name <service name>'))
  const command = paramString(params, ['command'])
  const url = paramString(params, ['url'])
  if (!command === !url) usage(pick('要给 --command <启动命令>（本地程序）或 --url <地址>（网络服务），二选一', 'Give either --command <start command> (local program) or --url <address> (network service)'))
  const args = stringList(params.args ?? params.arg, 'args')
  const env = envOf(params.env)
  const reason = paramString(params, ['reason', 'purpose'])
  const scope = paramString(params, ['scope'])
  return {
    name,
    ...(command ? { command } : {}),
    ...(args?.length ? { args } : {}),
    ...(url ? { url } : {}),
    ...(env ? { env } : {}),
    ...(params.app === true || params.app === 'true' ? { app: true } : {}),
    ...(scope ? { scope } : {}),
    ...(reason ? { reason } : {})
  }
}

function serviceView(service: McpSettingsService) {
  return {
    name: service.name,
    scope: service.scope,
    enabled: service.enabled,
    inherited: service.inherited,
    transport: service.transport,
    connection: service.connection,
    connectedBy: service.owner === 'inkstone' ? 'inkstone' : 'pi',
    ...(service.special ? { managedIn: 'local-tools' } : {}),
    ...(service.pluginManaged ? { managedIn: 'plugin' } : {})
  }
}

function findService(snapshot: McpSettingsSnapshot, name: string, scope?: string): { service: McpSettingsService; scope: 'global' | 'project' } | null {
  const own = snapshot.projectServices.find((item) => item.name === name && !item.inherited)
  if (own) return { service: own, scope: 'project' }
  if (scope === 'project') {
    const inherited = snapshot.projectServices.find((item) => item.name === name)
    if (inherited) return { service: inherited, scope: 'project' }
  }
  const global = snapshot.global.find((item) => item.name === name)
  return global ? { service: global, scope: 'global' } : null
}

async function mcpServices(services: InstallServices, command: string) {
  const snapshot = await services.mcpServices()
  const servicesList = [...snapshot.global.map(serviceView), ...snapshot.projectServices.filter((item) => !item.inherited).map(serviceView)]
  return result(command, 'listed', pick('这些是已配置的 MCP 服务（不含连接状态；工具清单用 yan mcp list）。', 'These are the configured MCP services (no connection status; use yan mcp list for tools).'), {
    services: servicesList,
    ...(snapshot.project ? { project: snapshot.project.name, projectTrusted: snapshot.projectTrusted } : {}),
    ...(snapshot.errors.length ? { configProblems: snapshot.errors } : {})
  })
}

export async function runMcpAdd(host: InstallCommandHost, services: InstallServices, request: McpAddRequest, command = 'mcp.add') {
  const first = await services.mcpServices()
  if (findService(first, request.name)) usage(pick(`已经有叫「${request.name}」的服务；换个名字，或用 yan mcp services 查看现有的`, `A service named "${request.name}" exists; pick another name or check yan mcp services`))
  const projectOption = first.project && first.projectTrusted ? ONLY_PROJECT(first.project.name) : undefined
  const options = request.scope === 'project' && projectOption ? [projectOption, ALL_SESSIONS()] : [ALL_SESSIONS(), ...(projectOption ? [projectOption] : [])]
  const envNames = Object.keys(request.env ?? {})
  const approval = await ask(host, pick(`添加 MCP 服务「${request.name}」`, `Add MCP service "${request.name}"`), [
    request.reason && pick(`用途：${request.reason}`, `Purpose: ${request.reason}`),
    request.url
      ? pick(`服务地址：${request.url}`, `Address: ${request.url}`)
      : pick(`启动命令：${[request.command, ...(request.args ?? [])].join(' ')}`, `Start command: ${[request.command, ...(request.args ?? [])].join(' ')}`),
    envNames.length > 0 && pick(`环境变量：${envNames.join('、')}（值不显示）`, `Environment variables: ${envNames.join(', ')} (values hidden)`),
    request.app && pick('带界面（MCP App），由砚连接', 'Has a UI (MCP App), connected by Inkstone'),
    request.source && pick(`来源：${request.source}`, `Source: ${request.source}`),
    request.url
      ? pick('这个服务会收到发给它的请求内容。', 'This service receives the requests sent to it.')
      : pick('启动命令会以你的身份在这台电脑上运行，没有沙箱。', 'The start command runs on this computer as you, without a sandbox.'),
    !!first.project && !first.projectTrusted && pick('当前项目还没有被信任，只能添加到全局。', 'The current project is not trusted yet, so it can only be added globally.')
  ], options)
  if (approval.kind !== 'chosen') return notApproved(command, approval)
  const scope = approval.choice === projectOption ? 'project' : 'global'
  const latest = await services.mcpServices()
  const saved = await services.mcpChange({
    context: latest.context,
    revision: latest.revision,
    scope,
    action: 'add',
    name: request.name,
    owner: request.app ? 'inkstone' : 'pi',
    config: {
      ...(request.url ? { url: request.url } : { command: request.command, ...(request.args ? { args: request.args } : {}) }),
      ...(request.env ? { env: request.env } : {})
    }
  })
  if (!saved.ok) return result(command, 'failed', pick(`没有添加：${saved.error ?? '未知原因'}`, `Not added: ${saved.error ?? 'unknown reason'}`), { name: request.name })
  services.refresh()
  return result(command, 'done', APPLIED(), { name: request.name, scope, ...(saved.warning ? { warning: saved.warning } : {}) })
}

async function mcpToggle(host: InstallCommandHost, services: InstallServices, command: string, action: 'remove' | 'enable' | 'disable', params: Record<string, unknown>) {
  const name = paramString(params, ['name', 'server', 'serverId'])
  if (!name) usage(pick('需要 --name <服务名>（先用 yan mcp services 查看）', 'Needs --name <service name> (check yan mcp services first)'))
  const scopeHint = paramString(params, ['scope'])
  const found = findService(await services.mcpServices(), name, scopeHint)
  if (!found) usage(pick(`没有叫「${name}」的服务；用 yan mcp services 查看现有的`, `No service named "${name}"; check yan mcp services`))
  const verb = action === 'remove' ? pick('删除', 'Remove') : action === 'enable' ? pick('启用', 'Enable') : pick('停用', 'Disable')
  const where = found.scope === 'project' ? pick('当前项目', 'current project') : pick('所有会话', 'all sessions')
  const approval = await ask(host, pick(`${verb} MCP 服务「${name}」`, `${verb} MCP service "${name}"`), [
    pick(`范围：${where}`, `Scope: ${where}`),
    found.service.connection && pick(`连接：${found.service.connection}`, `Connection: ${found.service.connection}`)
  ], [ALLOW()])
  if (approval.kind !== 'chosen') return notApproved(command, approval)
  const latest = await services.mcpServices()
  const again = findService(latest, name, scopeHint)
  if (!again) return result(command, 'failed', pick('服务已经不在了，没有改动。', 'The service is gone; nothing changed.'), { name })
  const saved = await services.mcpChange({ context: latest.context, revision: latest.revision, scope: again.scope, action, key: again.service.key })
  if (!saved.ok) return result(command, 'failed', pick(`没有改动：${saved.error ?? '未知原因'}`, `Nothing changed: ${saved.error ?? 'unknown reason'}`), { name })
  services.refresh()
  return result(command, 'done', APPLIED(), { name, scope: again.scope })
}

async function pluginCommand(host: InstallCommandHost, services: InstallServices, command: string, params: Record<string, unknown>) {
  const plugins = await services.plugins()
  if (command === 'plugin.list') {
    return result(command, 'listed', pick('这些是砚插件，用 yan plugin install --id <ID> 安装。', 'These are Inkstone plugins; install with yan plugin install --id <ID>.'), { plugins })
  }
  const id = paramString(params, ['id', 'plugin'])
  const plugin = plugins.find((item) => item.id === id)
  if (!plugin) usage(pick(`没有这个砚插件：${id ?? '（没给 --id）'}；可用的见 yan plugin list`, `No such Inkstone plugin: ${id ?? '(no --id)'}; see yan plugin list`))
  const action = command === 'plugin.install' ? 'install' : 'remove'
  const approval = await ask(host, action === 'install'
    ? pick(`安装砚插件「${plugin.name}」`, `Install Inkstone plugin "${plugin.name}"`)
    : pick(`卸载砚插件「${plugin.name}」`, `Uninstall Inkstone plugin "${plugin.name}"`), [
    plugin.desc,
    action === 'install' && plugin.installed && pick('已经装过，会重新安装。', 'Already installed; it will be reinstalled.'),
    action === 'install' && pick('插件会以你的身份在这台电脑上运行。', 'The plugin runs on this computer as you.')
  ], [ALLOW()])
  if (approval.kind !== 'chosen') return notApproved(command, approval)
  const done = await services.pluginAction(plugin.id, action)
  if (!done.ok) return result(command, 'failed', pick(`没有完成：${done.error ?? '未知原因'}`, `Not done: ${done.error ?? 'unknown reason'}`), { id: plugin.id })
  services.refresh()
  return result(command, 'done', APPLIED(), { id: plugin.id, installed: done.installed === true })
}

function packageView(listing: PackageListing) {
  return listing.entries.map((entry) => ({ name: entry.name, version: entry.version, scope: entry.scope, source: entry.source, installed: entry.installed }))
}

async function packageCommand(host: InstallCommandHost, services: InstallServices, command: string, params: Record<string, unknown>) {
  if (command === 'package.list') {
    const listing = services.packages()
    if (!listing.ok) return result(command, 'failed', pick(`读不到 pi 插件清单：${listing.error ?? '未知原因'}`, `Cannot read the pi plugin list: ${listing.error ?? 'unknown reason'}`))
    return result(command, 'listed', pick('这些是已登记的 pi 插件（scope=user 是全局，project 是当前项目）。', 'These are the registered pi plugins (scope=user is global, project is the current project).'), { packages: packageView(listing) })
  }
  const project = await services.project()
  if (command === 'package.remove') {
    const target = paramString(params, ['source', 'name', 'package'])
    if (!target) usage(pick('需要 --source <来源或包名>（先用 yan package list 查看）', 'Needs --source <source or package name> (check yan package list first)'))
    const entry = services.packages().entries.find((item) => item.source === target || item.name === target)
    if (!entry) usage(pick(`没有登记「${target}」；用 yan package list 查看`, `"${target}" is not registered; check yan package list`))
    const approval = await ask(host, pick(`卸载 pi 插件「${entry.name}」`, `Uninstall pi plugin "${entry.name}"`), [
      pick(`来源：${entry.source}`, `Source: ${entry.source}`),
      pick(`范围：${entry.scope === 'project' ? '当前项目' : '所有项目'}`, `Scope: ${entry.scope === 'project' ? 'current project' : 'all projects'}`)
    ], [ALLOW()])
    if (approval.kind !== 'chosen') return notApproved(command, approval)
    const done = await services.packageAction({ kind: 'remove', source: entry.source, local: entry.scope === 'project' })
    if (!done.ok) return result(command, 'failed', pick(`没有卸载：${done.error ?? '未知原因'}`, `Not removed: ${done.error ?? 'unknown reason'}`), { source: entry.source, ...(done.detail ? { detail: done.detail.slice(-1500) } : {}) })
    services.refresh()
    return result(command, 'done', APPLIED(), { source: entry.source })
  }
  const source = paramString(params, ['source', 'package'])
  if (!source) usage(pick('需要 --source <npm:包名@版本 | git:github.com/用户/仓库>', 'Needs --source <npm:name@version | git:github.com/user/repo>'))
  const invalid = validatePackageSource(source)
  if (invalid) usage(invalid)
  const reason = paramString(params, ['reason', 'purpose'])
  const projectOption = project?.trusted ? ONLY_PROJECT(project.name) : undefined
  const options = paramString(params, ['scope']) === 'project' && projectOption ? [projectOption, ALL_PROJECTS()] : [ALL_PROJECTS(), ...(projectOption ? [projectOption] : [])]
  const approval = await ask(host, pick(`安装 pi 插件 ${source}`, `Install pi plugin ${source}`), [
    reason && pick(`用途：${reason}`, `Purpose: ${reason}`),
    pick(`来源：${source}`, `Source: ${source}`),
    pick('pi 插件以你的身份运行代码，没有沙箱。装好后砚会先试加载一次，加载失败就撤销安装；安装脚本（npm lifecycle）不运行。', 'pi plugins run code as you, without a sandbox. Inkstone test-loads it after install and undoes the install if loading fails; install scripts (npm lifecycle) do not run.'),
    !!project && !project.trusted && pick('当前项目还没有被信任，只能装到全局。', 'The current project is not trusted yet, so it can only be installed globally.')
  ], options)
  if (approval.kind !== 'chosen') return notApproved(command, approval)
  const local = approval.choice === projectOption
  const done = await services.packageAction({ kind: 'install', source, local })
  if (!done.ok) return result(command, 'failed', pick(`没有装上：${done.error ?? '未知原因'}`, `Not installed: ${done.error ?? 'unknown reason'}`), { source, ...(done.detail ? { detail: done.detail.slice(-1500) } : {}) })
  services.refresh()
  return result(command, 'done', APPLIED(), { source, scope: local ? 'project' : 'user' })
}

function servicesOf(host: InstallCommandHost): InstallServices {
  const services = host.services()
  if (!services) throw new CapabilityCommandError('install_unavailable', pick('这个会话不能安装或改动能力', 'This session cannot install or change capabilities'))
  return services
}

export function runMcpAddFor(host: InstallCommandHost, request: McpAddRequest) {
  return runMcpAdd(host, servicesOf(host), request, 'capabilities.acquire')
}

export async function runInstallCommand(host: InstallCommandHost, command: string, params: Record<string, unknown>) {
  const services = servicesOf(host)
  if (command === 'mcp.services') return mcpServices(services, command)
  if (command === 'mcp.add') return runMcpAdd(host, services, mcpAddRequestOf(params))
  if (command === 'mcp.remove' || command === 'mcp.enable' || command === 'mcp.disable') return mcpToggle(host, services, command, command.slice(4) as 'remove' | 'enable' | 'disable', params)
  if (command.startsWith('plugin.')) return pluginCommand(host, services, command, params)
  if (command.startsWith('package.')) return packageCommand(host, services, command, params)
  throw new CapabilityCommandError('not_implemented', `${command}`)
}
