import { randomBytes } from 'node:crypto'
import { readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { isInkstoneManaged, type McpAppNativeEntry, type McpAppServerConfig } from './app-spec'
import { atomicWrite, nativeMcpTextFingerprint } from './native-import'
import { serializedWrite } from './write-queue'
import { mcpServersFile, parseMcpServersDocument } from './config'
import { nativeMcpServerName, WINDOWS_MCP_SERVER_ID } from '../../shared/mcp-native-import'
import type { McpMigratedToNativeMark, McpServerConfig } from '../../shared/mcp'
import type {
  McpAppOwnershipView,
  McpAppSwitchCommitResult,
  McpAppSwitchDirection,
  McpAppSwitchHolder,
  McpAppSwitchPreview,
  McpAppSwitchVerifyInput,
  McpAppSwitchVerifyResult
} from '../../shared/mcp-app-switch'
import { summarizeMcpAppNativeEntry } from '../../shared/mcp-app-switch'

export class McpAppSwitchError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'McpAppSwitchError'
  }
}

export interface McpAppSwitchProject {
  id: string
  cwd: string
}

export interface McpAppSwitchHolderProvider {
  holdersFor(server: {
    serverId: string
    scope: 'global' | 'project'
    projectId?: string
  }): Promise<McpAppSwitchHolder[]>
  runtimeEpoch?(): string
}

export interface McpAppSwitchOwner {
  id: string
}

export interface McpAppSwitchHost {
  agentDir: string
  hostConfigFile?: string
  projects: readonly McpAppSwitchProject[]
  holders?: McpAppSwitchHolderProvider
  disconnectHost?: (serverId: string) => Promise<void>
  verify?: (input: McpAppSwitchVerifyInput) => Promise<McpAppSwitchVerifyResult>
  writeText?: (path: string, text: string, expectedFingerprint?: string) => Promise<void>
  now?: () => number
  generateToken?: () => string
  tokenTtlMs?: number
}

interface PendingSwitch {
  ownerId: string
  direction: McpAppSwitchDirection
  serverId: string
  nativeName: string
  scope: 'global' | 'project'
  projectId?: string
  projectCwd?: string
  targetPath: string
  hostConfigFile: string
  agentDir: string
  targetContent: string
  hostContent: string
  targetOriginalText: string | null
  hostOriginalText: string
  warnings: string[]
  targetFingerprint: string
  hostFingerprint: string
  guardEpoch?: string
  expiresAt: number
}

const MAX_PENDING_SWITCHES = 32

const pendingSwitches = new Map<string, PendingSwitch>()

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function hostConfigPathOf(host: McpAppSwitchHost): string {
  return host.hostConfigFile ?? mcpServersFile()
}

function serializeDocument(document: unknown): string {
  return `${JSON.stringify(document, null, 2)}\n`
}

async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function defaultToken(): string {
  return randomBytes(24).toString('base64url')
}

function pruneExpired(nowMs: number): void {
  for (const [token, pending] of pendingSwitches) {
    if (pending.expiresAt <= nowMs) pendingSwitches.delete(token)
  }
}

export function mcpAppUnsupportedReason(config: McpServerConfig): string | undefined {
  if (config.id === WINDOWS_MCP_SERVER_ID) {
    return 'windows-mcp 保留在砚的连接里（电脑操作需要排队与用户接管），首版不纳入托管'
  }
  if (config.transport !== 'stdio' && config.transport !== 'http') {
    return `不支持的 transport：${String(config.transport)}`
  }
  return undefined
}

export function mcpAppNativeRecord(config: McpAppServerConfig): McpAppNativeEntry | undefined {
  return config.appHost?.natives?.[0]
}

export function mcpAppSwitchDirectionOf(config: McpAppServerConfig): McpAppSwitchDirection {
  return isInkstoneManaged(config) ? 'to-pi' : 'to-inkstone'
}

interface LocatedEntry {
  kind: 'array' | 'object'
  index: number
  record: Record<string, unknown>
}

function locateHostEntry(document: unknown, serverId: string): LocatedEntry | null {
  const list = Array.isArray(document)
    ? document
    : Array.isArray((document as { servers?: unknown } | null)?.servers)
      ? ((document as { servers: unknown[] }).servers)
      : null
  if (!list) return null
  for (let index = 0; index < list.length; index++) {
    const record = asRecord(list[index])
    if (record && record.id === serverId) {
      return { kind: Array.isArray(document) ? 'array' : 'object', index, record }
    }
  }
  return null
}

function applyHostEntry(document: unknown, located: LocatedEntry, patched: Record<string, unknown>): unknown {
  const list = Array.isArray(document)
    ? [...document]
    : [...((document as { servers: unknown[] }).servers ?? [])]
  list[located.index] = patched
  if (located.kind === 'array') return list
  return { ...(document as Record<string, unknown>), servers: list }
}

function upsertNativeRecord(natives: readonly unknown[], incoming: McpAppNativeEntry): unknown[] {
  const rest = natives.filter((item) => {
    const record = asRecord(item)
    return !(record && record.path === incoming.path && record.name === incoming.name)
  })
  return [...rest, incoming]
}

function enrollHostEntry(options: {
  document: unknown
  serverId: string
  at: string
  native: McpAppNativeEntry
}): { ok: true; document: unknown } | { ok: false; reason: string } {
  const located = locateHostEntry(options.document, options.serverId)
  if (!located) return { ok: false, reason: `砚配置里没有 id 为 ${options.serverId} 的条目` }
  const existingHost = asRecord(located.record.appHost)
  const existingNatives = Array.isArray(existingHost?.natives) ? existingHost.natives : []
  const { migratedToNative: _drop, ...rest } = located.record
  const patched: Record<string, unknown> = {
    ...rest,
    enabled: true,
    ownedBy: 'inkstone',
    appHost: { ...(existingHost ?? {}), at: options.at, natives: upsertNativeRecord(existingNatives, options.native) }
  }
  return { ok: true, document: applyHostEntry(options.document, located, patched) }
}

function releaseHostEntry(options: {
  document: unknown
  serverId: string
  mark: McpMigratedToNativeMark
}): { ok: true; document: unknown } | { ok: false; reason: string } {
  const located = locateHostEntry(options.document, options.serverId)
  if (!located) return { ok: false, reason: `砚配置里没有 id 为 ${options.serverId} 的条目` }
  const { appHost: _drop, ...rest } = located.record
  const patched: Record<string, unknown> = {
    ...rest,
    enabled: false,
    ownedBy: 'pi',
    migratedToNative: options.mark
  }
  return { ok: true, document: applyHostEntry(options.document, located, patched) }
}

function nativeEntryOf(document: unknown, name: string): { present: boolean; entry?: unknown } {
  const servers = asRecord(asRecord(document)?.mcpServers)
  if (!servers || !Object.prototype.hasOwnProperty.call(servers, name)) return { present: false }
  return { present: true, entry: servers[name] }
}

function removeNativeEntry(document: unknown, name: string): { ok: true; document: unknown } | { ok: false; reason: string } {
  const root = asRecord(document)
  if (!root) return { ok: false, reason: 'pi 原生配置顶层必须是 JSON 对象' }
  const servers = asRecord(root.mcpServers)
  if (!servers) return { ok: false, reason: 'pi 原生配置里的 mcpServers 必须是对象' }
  const next = { ...servers }
  delete next[name]
  return { ok: true, document: { ...root, mcpServers: next } }
}

function insertNativeEntry(
  document: unknown,
  name: string,
  entry: unknown,
  absent: boolean
): { ok: true; document: unknown } | { ok: false; reason: string } {
  if (absent) return { ok: true, document: { mcpServers: { [name]: entry } } }
  if (document === null) return { ok: false, reason: 'pi 原生配置解析结果是 JSON null（坏配置），拒绝覆盖' }
  const root = asRecord(document)
  if (!root) return { ok: false, reason: 'pi 原生配置顶层必须是 JSON 对象' }
  const current = root.mcpServers
  if (current !== undefined && !asRecord(current)) {
    return { ok: false, reason: 'pi 原生配置里的 mcpServers 必须是对象，拒绝改写成其它形状' }
  }
  const servers = (asRecord(current) ?? {}) as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(servers, name)) {
    return { ok: false, reason: `pi 原生配置已经有同名服务「${name}」，拒绝覆盖` }
  }
  return { ok: true, document: { ...root, mcpServers: { ...servers, [name]: entry } } }
}

interface NativeLocation {
  path: string
  scope: 'global' | 'project'
  projectId?: string
  projectCwd?: string
}

function nativeLocations(host: McpAppSwitchHost): NativeLocation[] {
  const locations: NativeLocation[] = [{ path: join(host.agentDir, 'mcp.json'), scope: 'global' }]
  for (const project of host.projects) {
    if (!project || typeof project.id !== 'string' || typeof project.cwd !== 'string' || !project.cwd.trim()) continue
    locations.push({ path: join(project.cwd, '.pi', 'mcp.json'), scope: 'project', projectId: project.id, projectCwd: project.cwd })
  }
  return locations
}

function samePath(a: string, b: string): boolean {
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()
}

async function inspectNativeLocations(options: {
  host: McpAppSwitchHost
  name: string
  targetPath: string
}): Promise<{ targetPresent: boolean; collisions: string[] }> {
  let targetPresent = false
  const collisions: string[] = []
  for (const location of nativeLocations(options.host)) {
    const text = await readTextOrNull(location.path)
    const present = text !== null && nativeEntryOf(safeParse(text), options.name).present
    if (samePath(location.path, options.targetPath)) {
      targetPresent = present
    } else if (present) {
      collisions.push(location.path)
    }
  }
  return { targetPresent, collisions }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

interface HolderQuery {
  serverId: string
  scope: 'global' | 'project'
  projectId?: string
}

async function requireHolders(
  host: McpAppSwitchHost,
  query: HolderQuery
): Promise<{ holders: McpAppSwitchHolder[]; epoch?: string }> {
  if (!host.holders) {
    throw new McpAppSwitchError(
      'holders_unavailable',
      '宿主未提供运行时持有者守卫，无法确认是否有运行实例仍持有该服务，拒绝切换'
    )
  }
  let epoch: string | undefined
  try {
    epoch = host.holders.runtimeEpoch?.()
  } catch {
    throw new McpAppSwitchError('holders_unavailable', '运行时 epoch 不可用，无法在写入前复核实例状态，拒绝切换')
  }
  let holders: unknown
  try {
    holders = await host.holders.holdersFor(query)
  } catch {
    throw new McpAppSwitchError('holders_unavailable', '读取运行时持有者失败，无法确认是否有实例持有该服务，拒绝切换')
  }
  if (!Array.isArray(holders)) {
    throw new McpAppSwitchError('holders_unavailable', '运行时持有者返回了非数组，无法确认是否无人持有，拒绝切换')
  }
  return { holders: holders as McpAppSwitchHolder[], ...(epoch !== undefined ? { epoch } : {}) }
}

async function recheckHoldersBeforeWrite(
  host: McpAppSwitchHost,
  query: HolderQuery,
  expectedEpoch: string | undefined
): Promise<void> {
  const current = await requireHolders(host, query)
  if (current.holders.length > 0) {
    throw new McpAppSwitchError(
      'holders_active',
      `仍有 ${current.holders.length} 个已加载运行实例可能持有该服务，写入前拒绝切换`
    )
  }
  if (expectedEpoch !== undefined && current.epoch !== expectedEpoch) {
    throw new McpAppSwitchError('runtime_changed', '运行时实例集合在核对后发生了变化，写入前拒绝切换')
  }
}

export async function prepareMcpAppSwitch(input: {
  host: McpAppSwitchHost
  serverId: string
  owner: McpAppSwitchOwner
}): Promise<McpAppSwitchPreview> {
  const { host, owner } = input
  const serverId = typeof input.serverId === 'string' ? input.serverId.trim() : ''
  if (!serverId) throw new McpAppSwitchError('server_required', '需要明确的服务 id')
  if (!owner || typeof owner.id !== 'string' || !owner.id.trim()) {
    throw new McpAppSwitchError('owner_required', '缺少调用者身份，拒绝生成切换令牌')
  }

  const hostConfigFile = hostConfigPathOf(host)
  let hostText: string | null
  try {
    hostText = await readTextOrNull(hostConfigFile)
  } catch (error) {
    throw new McpAppSwitchError('host_config_unreadable', `无法读取砚的 MCP 配置 ${hostConfigFile}：${messageOf(error)}`)
  }
  if (hostText === null) throw new McpAppSwitchError('host_config_missing', `砚的 MCP 配置不存在：${hostConfigFile}`)
  const parsed = parseMcpServersDocument(hostText, hostConfigFile)
  if (parsed.error) {
    throw new McpAppSwitchError('host_config_invalid', `砚的 MCP 配置存在解析问题，拒绝基于部分有效条目切换：${parsed.error}`)
  }
  const config = parsed.servers.find((server) => server.id === serverId)
  if (!config) throw new McpAppSwitchError('server_unknown', `砚的 MCP 配置里没有 id 为 ${serverId} 的服务`)

  const unsupported = mcpAppUnsupportedReason(config)
  if (unsupported) throw new McpAppSwitchError('unsupported', unsupported)

  const direction = mcpAppSwitchDirectionOf(config)

  let scope: 'global' | 'project' = 'global'
  let projectId: string | undefined
  let projectCwd: string | undefined
  let targetPath = join(host.agentDir, 'mcp.json')
  if (config.projectScope?.trim()) {
    projectId = config.projectScope.trim()
    const project = host.projects.find((entry) => entry.id === projectId)
    if (!project || !project.cwd?.trim()) {
      throw new McpAppSwitchError(
        'unregistered_project',
        `服务 ${serverId} 的项目范围指向未登记项目 ${projectId}；只认受信项目登记，不按目录反推`
      )
    }
    scope = 'project'
    projectCwd = project.cwd
    targetPath = join(project.cwd, '.pi', 'mcp.json')
  }

  const named = nativeMcpServerName(serverId)
  if (!named.ok) throw new McpAppSwitchError('server_name_invalid', named.reason)
  let nativeName = named.name
  let nativeEntry: unknown

  if (direction === 'to-pi') {
    const record = mcpAppNativeRecord(config)
    if (!record) {
      throw new McpAppSwitchError('missing_apphost', `服务 ${serverId} 缺少 appHost 回退记录，不能在未保存原条目的情况下交回 pi`)
    }
    nativeName = record.name
    targetPath = record.path
    nativeEntry = record.entry
  }

  let targetText: string | null
  try {
    targetText = await readTextOrNull(targetPath)
  } catch (error) {
    throw new McpAppSwitchError('target_unreadable', `无法读取 pi 原生配置 ${targetPath}：${messageOf(error)}`)
  }
  const targetDocument: unknown = targetText === null ? undefined : safeParse(targetText)
  if (targetText !== null && targetDocument === undefined) {
    throw new McpAppSwitchError('target_invalid_json', `pi 原生配置不是合法 JSON（${targetPath}），拒绝改写`)
  }

  const { collisions } = await inspectNativeLocations({ host, name: nativeName, targetPath })
  if (collisions.length > 0) {
    throw new McpAppSwitchError(
      'native_name_conflict',
      `另有 pi 原生位置已有同名服务「${nativeName}」：${collisions.join('、')}；请先处理同名项再切换`
    )
  }

  let targetContent: string
  let hostContent: string
  const warnings: string[] = []

  if (direction === 'to-inkstone') {
    const current = nativeEntryOf(targetDocument, nativeName)
    if (!current.present) {
      throw new McpAppSwitchError(
        'native_entry_missing',
        `pi 原生配置 ${targetPath} 里没有服务「${nativeName}」，没有可移出的条目`
      )
    }
    nativeEntry = current.entry
    const removed = removeNativeEntry(targetDocument, nativeName)
    if (!removed.ok) throw new McpAppSwitchError('target_shape', removed.reason)
    targetContent = serializeDocument(removed.document)

    const nativeRecord: McpAppNativeEntry = {
      path: targetPath,
      name: nativeName,
      entry: nativeEntry,
      fingerprint: nativeMcpTextFingerprint(targetText)
    }
    const enrolled = enrollHostEntry({
      document: parsed.document,
      serverId,
      at: new Date((host.now ?? Date.now)()).toISOString(),
      native: nativeRecord
    })
    if (!enrolled.ok) throw new McpAppSwitchError('host_shape', enrolled.reason)
    hostContent = serializeDocument(enrolled.document)
    warnings.push('原 pi 条目（含 env 等）已逐字保存到砚配置的 appHost.natives，回退时原样写回；请勿手动删除该记录。')
    if (config.authRef?.trim()) {
      warnings.push(`authRef「${config.authRef}」是砚侧凭证引用，不随条目迁移；砚托管连接仍需该凭证可用。`)
    }
  } else {
    const current = nativeEntryOf(targetDocument, nativeName)
    if (current.present) {
      throw new McpAppSwitchError('native_name_conflict', `pi 原生配置已经有同名服务「${nativeName}」，拒绝覆盖`)
    }
    const inserted = insertNativeEntry(targetDocument, nativeName, nativeEntry, targetText === null)
    if (!inserted.ok) throw new McpAppSwitchError('target_shape', inserted.reason)
    targetContent = serializeDocument(inserted.document)

    const mark: McpMigratedToNativeMark = {
      at: new Date((host.now ?? Date.now)()).toISOString(),
      targetPath,
      nativeName
    }
    const released = releaseHostEntry({ document: parsed.document, serverId, mark })
    if (!released.ok) throw new McpAppSwitchError('host_shape', released.reason)
    hostContent = serializeDocument(released.document)
    if (config.authRef?.trim()) {
      warnings.push(`authRef「${config.authRef}」是砚侧凭证引用，写回 pi 后请在 pi 里重新登录服务 ${nativeName}（pi mcp login ${nativeName}）。`)
    }
    if (config.effect && config.effect !== 'unknown') {
      warnings.push('effect 只作用于砚的权限判断，没有原生对应；pi 侧按工具注解与自身规则处理。')
    }
  }

  const holderQuery: HolderQuery = { serverId, scope, ...(projectId ? { projectId } : {}) }
  let holders: McpAppSwitchHolder[] = []
  let guardEpoch: string | undefined
  if (direction === 'to-inkstone') {
    const resolved = await requireHolders(host, holderQuery)
    holders = resolved.holders
    guardEpoch = resolved.epoch
  }
  const blocked = direction === 'to-inkstone' && holders.length > 0

  const nowMs = (host.now ?? Date.now)()
  pruneExpired(nowMs)
  if (pendingSwitches.size >= MAX_PENDING_SWITCHES) {
    throw new McpAppSwitchError(
      'too_many_pending',
      `同时待确认的切换已达上限（${MAX_PENDING_SWITCHES} 个），请先完成或等已过期的令牌释放后重试`
    )
  }
  const token = (host.generateToken ?? defaultToken)()
  const expiresAt = nowMs + (host.tokenTtlMs ?? 2 * 60_000)
  pendingSwitches.set(token, {
    ownerId: owner.id.trim(),
    direction,
    serverId,
    nativeName,
    scope,
    ...(projectId ? { projectId } : {}),
    ...(projectCwd ? { projectCwd } : {}),
    targetPath,
    hostConfigFile,
    agentDir: host.agentDir,
    targetContent,
    hostContent,
    targetOriginalText: targetText,
    hostOriginalText: hostText,
    warnings,
    targetFingerprint: nativeMcpTextFingerprint(targetText),
    hostFingerprint: nativeMcpTextFingerprint(hostText),
    ...(guardEpoch !== undefined ? { guardEpoch } : {}),
    expiresAt
  })

  const blockedReason = blocked
    ? `仍有 ${holders.length} 个已加载运行实例可能持有该服务；首版不自动重启。请先退出相关会话（或等其实例释放）后再切换。`
    : undefined

  return {
    token,
    expiresAt: new Date(expiresAt).toISOString(),
    direction,
    serverId,
    nativeName,
    scope,
    ...(projectId ? { projectId } : {}),
    ...(projectCwd ? { projectCwd } : {}),
    targetPath,
    hostConfigFile,
    entry: summarizeMcpAppNativeEntry(nativeEntry),
    warnings,
    blocked,
    ...(blockedReason ? { blockedReason } : {}),
    holders
  }
}

function skippedSteps(): McpAppSwitchCommitResult['steps'] {
  return { native: 'skipped', host: 'skipped', verify: 'skipped', hostDisconnect: 'skipped' }
}

async function restoreNative(
  writeText: (path: string, text: string, expectedFingerprint?: string) => Promise<void>,
  pending: PendingSwitch
): Promise<McpAppSwitchCommitResult['remediation']> {
  try {
    const current = await readTextOrNull(pending.targetPath)
    const currentFingerprint = nativeMcpTextFingerprint(current)
    if (currentFingerprint !== nativeMcpTextFingerprint(pending.targetContent)) {
      return 'remediation-failed'
    }
    if (pending.targetOriginalText === null) {
      await unlink(pending.targetPath)
      return 'restored'
    }
    await writeText(pending.targetPath, pending.targetOriginalText, currentFingerprint)
    return 'restored'
  } catch {
    return 'remediation-failed'
  }
}

async function precheckSwitch(host: McpAppSwitchHost, pending: PendingSwitch): Promise<void> {
  let hostText: string | null
  try {
    hostText = await readTextOrNull(pending.hostConfigFile)
  } catch (error) {
    throw new McpAppSwitchError('host_config_unreadable', `无法读取砚的 MCP 配置：${messageOf(error)}`)
  }
  if (nativeMcpTextFingerprint(hostText) !== pending.hostFingerprint) {
    throw new McpAppSwitchError('host_changed', '预览后砚的 MCP 配置发生了变化，令牌已作废；请重新预览确认')
  }
  const parsed = parseMcpServersDocument(hostText ?? '', pending.hostConfigFile)
  if (parsed.error) throw new McpAppSwitchError('host_config_invalid', `砚配置解析失败：${parsed.error}`)
  const config = parsed.servers.find((server) => server.id === pending.serverId)
  if (!config) throw new McpAppSwitchError('server_unknown', `砚配置里已没有服务 ${pending.serverId}`)
  if (pending.direction === 'to-inkstone' && isInkstoneManaged(config)) {
    throw new McpAppSwitchError('already_managed', `服务 ${pending.serverId} 已被砚托管，请重新预览`)
  }
  if (pending.direction === 'to-pi' && !isInkstoneManaged(config)) {
    throw new McpAppSwitchError('not_managed', `服务 ${pending.serverId} 已不是砚托管状态，请重新预览`)
  }

  let targetText: string | null
  try {
    targetText = await readTextOrNull(pending.targetPath)
  } catch (error) {
    throw new McpAppSwitchError('target_unreadable', `无法读取 pi 原生配置：${messageOf(error)}`)
  }
  if (nativeMcpTextFingerprint(targetText) !== pending.targetFingerprint) {
    throw new McpAppSwitchError('target_changed', '预览后 pi 原生配置发生了变化，令牌已作废；请重新预览确认')
  }
  const present = targetText !== null && nativeEntryOf(safeParse(targetText), pending.nativeName).present
  if (pending.direction === 'to-inkstone' && !present) {
    throw new McpAppSwitchError('native_entry_missing', `pi 原生配置里已没有服务「${pending.nativeName}」`)
  }
  if (pending.direction === 'to-pi' && present) {
    throw new McpAppSwitchError('native_name_conflict', `pi 原生配置已有同名服务「${pending.nativeName}」，拒绝覆盖`)
  }
  const { collisions } = await inspectNativeLocations({ host, name: pending.nativeName, targetPath: pending.targetPath })
  if (collisions.length > 0) {
    throw new McpAppSwitchError('native_name_conflict', `另有 pi 原生位置已有同名服务：${collisions.join('、')}`)
  }
}

export async function commitMcpAppSwitch(input: {
  host: McpAppSwitchHost
  token: string
  owner: McpAppSwitchOwner
}): Promise<McpAppSwitchCommitResult> {
  const { host, token, owner } = input

  return serializedWrite(async (): Promise<McpAppSwitchCommitResult> => {
    const nowMs = (host.now ?? Date.now)()
    const pending = pendingSwitches.get(token)
    if (!pending) throw new McpAppSwitchError('token_invalid', '切换令牌无效或已被使用，请重新预览')
    if (pending.expiresAt <= nowMs) {
      pendingSwitches.delete(token)
      throw new McpAppSwitchError('token_expired', '切换令牌已过期，请重新预览')
    }
    if (!owner || pending.ownerId !== owner.id) {
      throw new McpAppSwitchError('token_owner_mismatch', '切换令牌与调用者身份不匹配，拒绝执行')
    }
    if (pending.agentDir !== host.agentDir || pending.hostConfigFile !== hostConfigPathOf(host)) {
      throw new McpAppSwitchError('host_mismatch', '切换令牌不是为当前宿主 / 数据目录生成的')
    }
    pendingSwitches.delete(token)

    const writeText = host.writeText ?? atomicWrite
    const base = {
      direction: pending.direction,
      serverId: pending.serverId,
      nativeName: pending.nativeName,
      targetPath: pending.targetPath,
      hostConfigFile: pending.hostConfigFile,
      warnings: pending.warnings
    }
    const nativeStep = pending.direction === 'to-inkstone' ? 'removed' : 'written'
    const hostStep = pending.direction === 'to-inkstone' ? 'enrolled' : 'released'

    const holderQuery: HolderQuery = {
      serverId: pending.serverId,
      scope: pending.scope,
      ...(pending.projectId ? { projectId: pending.projectId } : {})
    }

    if (pending.direction === 'to-inkstone') {
      let resolved: { holders: McpAppSwitchHolder[]; epoch?: string }
      try {
        resolved = await requireHolders(host, holderQuery)
      } catch (error) {
        return {
          ...base,
          ok: false,
          steps: { ...skippedSteps(), hostDisconnect: 'not-needed' },
          remediation: 'not-needed',
          notice: `${error instanceof McpAppSwitchError ? error.message : '无法确认运行时持有者'}；未做任何写入。`
        }
      }
      if (resolved.holders.length > 0) {
        return {
          ...base,
          ok: false,
          steps: { ...skippedSteps(), hostDisconnect: 'not-needed' },
          remediation: 'not-needed',
          notice: `仍有 ${resolved.holders.length} 个已加载运行实例可能持有该服务；首版不自动重启，已在写入前拒绝切换。请先退出相关会话。`
        }
      }
    }

    try {
      await precheckSwitch(host, pending)
    } catch (error) {
      const code = error instanceof McpAppSwitchError ? error.code : 'precheck_failed'
      return {
        ...base,
        ok: false,
        steps: { ...skippedSteps(), hostDisconnect: pending.direction === 'to-pi' ? 'skipped' : 'not-needed' },
        remediation: 'not-needed',
        notice: `写入前核对失败（${code}）：${messageOf(error)}；未做任何写入。`
      }
    }

    if (pending.direction === 'to-inkstone') {
      try {
        await recheckHoldersBeforeWrite(host, holderQuery, pending.guardEpoch)
      } catch (error) {
        return {
          ...base,
          ok: false,
          steps: { ...skippedSteps(), hostDisconnect: 'not-needed' },
          remediation: 'not-needed',
          notice: `${error instanceof McpAppSwitchError ? error.message : '运行时复核失败'}；未做任何写入。`
        }
      }
    }

    if (pending.direction === 'to-pi' && !host.disconnectHost) {
      return {
        ...base,
        ok: false,
        steps: { ...skippedSteps(), hostDisconnect: 'skipped' },
        remediation: 'not-needed',
        notice: '宿主未提供断开砚连接的回调，无法确认唯一所有者，拒绝写回 pi（未做任何写入）。'
      }
    }
    let hostDisconnect: McpAppSwitchCommitResult['steps']['hostDisconnect'] =
      pending.direction === 'to-pi' ? 'skipped' : 'not-needed'
    const disconnect = host.disconnectHost
    if (pending.direction === 'to-pi' && disconnect) {
      try {
        await disconnect(pending.serverId)
        hostDisconnect = 'disconnected'
      } catch (error) {
        return {
          ...base,
          ok: false,
          steps: { ...skippedSteps(), hostDisconnect: 'failed' },
          remediation: 'not-needed',
          notice: `断开砚宿主连接失败：${messageOf(error)}；未写入 pi 配置，砚托管保持原状。`
        }
      }
    }

    try {
      await writeText(pending.targetPath, pending.targetContent, pending.targetFingerprint)
    } catch (error) {
      return {
        ...base,
        ok: false,
        steps: { native: 'failed', host: 'skipped', verify: 'skipped', hostDisconnect },
        remediation: 'not-needed',
        notice: `写入 pi 原生配置失败：${messageOf(error)}；砚配置未改动。`
      }
    }

    try {
      await writeText(pending.hostConfigFile, pending.hostContent, pending.hostFingerprint)
    } catch (error) {
      const remediation = await restoreNative(writeText, pending)
      const suffix =
        remediation === 'restored'
          ? '已用保存的原值把 pi 配置恢复回去。'
          : 'pi 配置的自动恢复失败，两边可能都不完整，请按上方路径手动修复。'
      return {
        ...base,
        ok: false,
        steps: { native: nativeStep, host: 'failed', verify: 'skipped', hostDisconnect },
        remediation,
        notice: `写入砚配置失败：${messageOf(error)}；${suffix}`
      }
    }

    let verify: McpAppSwitchCommitResult['steps']['verify'] = 'unavailable'
    let verifyDetail: string | undefined
    if (host.verify) {
      try {
        const expectedFingerprint = nativeMcpTextFingerprint(pending.targetContent)
        const outcome = await host.verify({
          serverId: pending.serverId,
          nativeName: pending.nativeName,
          scope: pending.scope,
          targetPath: pending.targetPath,
          expectedFingerprint,
          expect: pending.direction === 'to-inkstone' ? 'absent' : 'present',
          ...(pending.projectId ? { projectId: pending.projectId } : {}),
          ...(pending.projectCwd ? { projectCwd: pending.projectCwd } : {})
        })
        verify = outcome.ok ? 'passed' : 'failed'
        verifyDetail = outcome.detail
      } catch (error) {
        verify = 'failed'
        verifyDetail = messageOf(error)
      }
    }

    const ok = verify !== 'failed'
    const how =
      pending.direction === 'to-inkstone'
        ? `已把 ${pending.serverId} 从 pi 原生移出（${pending.targetPath}），并写入砚托管声明与回退条目。`
        : `已把 ${pending.serverId} 交回 pi 原生（${pending.targetPath}），砚条目已停用并标记 migratedToNative。`
    const verifyTail =
      verify === 'passed'
        ? '原生存在性复核通过。'
        : verify === 'unavailable'
          ? '尚未接入 pi 原生存在性复核（宿主未注入 verify），已写入但未经运行确认。'
          : `原生存在性复核未通过${verifyDetail ? `：${verifyDetail}` : ''}。`
    return {
      ...base,
      ok,
      steps: { native: nativeStep, host: hostStep, verify, hostDisconnect },
      remediation: 'not-needed',
      notice: `${how}${verifyTail}`
    }
  })
}

export function mcpAppOwnershipView(input: {
  config: McpAppServerConfig
  holders: McpAppSwitchHolder[]
  projectScoped: boolean
  holdersUnknown?: boolean
}): McpAppOwnershipView {
  const { config, holders, projectScoped, holdersUnknown } = input
  const managed = isInkstoneManaged(config)
  const record = mcpAppNativeRecord(config)
  const unsupportedReason = mcpAppUnsupportedReason(config)
  const direction = managed ? 'to-pi' : 'to-inkstone'
  const blockedByHolders = direction === 'to-inkstone' && holders.length > 0
  const blockedByUnknown = direction === 'to-inkstone' && holdersUnknown === true
  const canSwitch =
    !unsupportedReason && !blockedByHolders && !blockedByUnknown && (managed ? Boolean(record) : true)
  const blockedReason = blockedByUnknown
    ? '无法确认是否有运行实例仍持有该服务，已按不可切换处理（fail-closed）。'
    : blockedByHolders
      ? `仍有 ${holders.length} 个已加载运行实例可能持有该服务；请先退出相关会话。`
      : managed && !record
        ? '缺少 appHost 回退记录，不能在未保存原条目的情况下交回 pi。'
        : undefined
  return {
    serverId: config.id,
    title: config.title ?? config.id,
    ownedBy: managed ? 'inkstone' : 'pi',
    managed,
    nativeName: record?.name ?? config.id,
    scope: config.projectScope ? 'project' : 'global',
    projectScoped,
    hasNativeRecord: Boolean(record),
    enabled: config.enabled !== false,
    holders,
    canSwitch,
    ...(blockedReason ? { blockedReason } : {}),
    ...(unsupportedReason ? { unsupportedReason } : {})
  }
}
