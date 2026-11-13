import { randomBytes } from 'node:crypto'
import { unlink, writeFile } from 'node:fs/promises'
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
import { pick } from '../../shared/ui-lang'
import { defaultNativeConfigReader as readTextOrNull } from './app-native-witness'

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
    return pick('电脑操作由砚直接连接（需要排队与用户接管），不需要切换托管。', 'Computer use is connected directly by Inkstone (queueing and user takeover); no hosting switch needed.')
  }
  if (config.transport !== 'stdio' && config.transport !== 'http') {
    return pick(`不支持的 transport：${String(config.transport)}`, `Unsupported transport: ${String(config.transport)}`)
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
  if (!located) return { ok: false, reason: pick(`砚配置里没有 id 为 ${options.serverId} 的条目`, `No entry with id ${options.serverId} in the Inkstone config`) }
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
  if (!located) return { ok: false, reason: pick(`砚配置里没有 id 为 ${options.serverId} 的条目`, `No entry with id ${options.serverId} in the Inkstone config`) }
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
  if (!root) return { ok: false, reason: pick('pi 原生配置顶层必须是 JSON 对象', 'The pi native config root must be a JSON object') }
  const servers = asRecord(root.mcpServers)
  if (!servers) return { ok: false, reason: pick('pi 原生配置里的 mcpServers 必须是对象', 'mcpServers in the pi native config must be an object') }
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
  if (document === null) return { ok: false, reason: pick('pi 原生配置解析结果是 JSON null（坏配置），拒绝覆盖', 'The pi native config parsed as JSON null (bad config); overwrite refused') }
  const root = asRecord(document)
  if (!root) return { ok: false, reason: pick('pi 原生配置顶层必须是 JSON 对象', 'The pi native config root must be a JSON object') }
  const current = root.mcpServers
  if (current !== undefined && !asRecord(current)) {
    return { ok: false, reason: pick('pi 原生配置里的 mcpServers 必须是对象，拒绝改写成其它形状', 'mcpServers in the pi native config must be an object; rewrite refused') }
  }
  const servers = (asRecord(current) ?? {}) as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(servers, name)) {
    return { ok: false, reason: pick(`pi 原生配置已经有同名服务「${name}」，拒绝覆盖`, `The pi native config already has a server named "${name}"; overwrite refused`) }
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
      pick('宿主未提供运行时持有者守卫，无法确认是否有运行实例仍持有该服务，拒绝切换', 'No runtime holder guard from the host; cannot confirm whether a runtime still holds this server. Switch refused')
    )
  }
  let epoch: string | undefined
  try {
    epoch = host.holders.runtimeEpoch?.()
  } catch {
    throw new McpAppSwitchError('holders_unavailable', pick('运行时 epoch 不可用，无法在写入前复核实例状态，拒绝切换', 'Runtime epoch unavailable; cannot recheck runtime state before writing. Switch refused'))
  }
  let holders: unknown
  try {
    holders = await host.holders.holdersFor(query)
  } catch {
    throw new McpAppSwitchError('holders_unavailable', pick('读取运行时持有者失败，无法确认是否有实例持有该服务，拒绝切换', 'Failed to read runtime holders; cannot confirm whether any runtime holds this server. Switch refused'))
  }
  if (!Array.isArray(holders)) {
    throw new McpAppSwitchError('holders_unavailable', pick('运行时持有者返回了非数组，无法确认是否无人持有，拒绝切换', 'Runtime holders returned a non-array; cannot confirm no one holds this server. Switch refused'))
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
      pick(`仍有 ${current.holders.length} 个已加载运行实例可能持有该服务，写入前拒绝切换`, `${current.holders.length} loaded runtime(s) may still hold this server; switch refused before writing`)
    )
  }
  if (expectedEpoch !== undefined && current.epoch !== expectedEpoch) {
    throw new McpAppSwitchError('runtime_changed', pick('运行时实例集合在核对后发生了变化，写入前拒绝切换', 'The runtime set changed after the check; switch refused before writing'))
  }
}

export async function prepareMcpAppSwitch(input: {
  host: McpAppSwitchHost
  serverId: string
  owner: McpAppSwitchOwner
}): Promise<McpAppSwitchPreview> {
  const { host, owner } = input
  const serverId = typeof input.serverId === 'string' ? input.serverId.trim() : ''
  if (!serverId) throw new McpAppSwitchError('server_required', pick('需要明确的服务 id', 'A server id is required'))
  if (!owner || typeof owner.id !== 'string' || !owner.id.trim()) {
    throw new McpAppSwitchError('owner_required', pick('缺少调用者身份，拒绝生成切换令牌', 'Missing caller identity; switch token refused'))
  }

  const hostConfigFile = hostConfigPathOf(host)
  let hostText: string | null
  try {
    hostText = await readTextOrNull(hostConfigFile)
  } catch (error) {
    throw new McpAppSwitchError('host_config_unreadable', pick(`无法读取砚的 MCP 配置 ${hostConfigFile}：${messageOf(error)}`, `Cannot read the Inkstone MCP config ${hostConfigFile}: ${messageOf(error)}`))
  }
  if (hostText === null) throw new McpAppSwitchError('host_config_missing', pick(`砚的 MCP 配置不存在：${hostConfigFile}`, `Inkstone MCP config not found: ${hostConfigFile}`))
  const parsed = parseMcpServersDocument(hostText, hostConfigFile)
  if (parsed.error) {
    throw new McpAppSwitchError('host_config_invalid', pick(`砚的 MCP 配置存在解析问题，拒绝基于部分有效条目切换：${parsed.error}`, `The Inkstone MCP config has parse errors; switching on partly valid entries refused: ${parsed.error}`))
  }
  const config = parsed.servers.find((server) => server.id === serverId)
  if (!config) throw new McpAppSwitchError('server_unknown', pick(`砚的 MCP 配置里没有 id 为 ${serverId} 的服务`, `No server with id ${serverId} in the Inkstone MCP config`))

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
        pick(`服务 ${serverId} 的项目范围指向未登记项目 ${projectId}；只认受信项目登记，不按目录反推`, `Server ${serverId} is scoped to unregistered project ${projectId}; only trusted project registrations are accepted`)
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
      throw new McpAppSwitchError('missing_apphost', pick(`服务 ${serverId} 缺少 appHost 回退记录，不能在未保存原条目的情况下交回 pi`, `Server ${serverId} has no appHost fallback record; cannot hand it back to pi without the original entry`))
    }
    nativeName = record.name
    targetPath = record.path
    nativeEntry = record.entry
  }

  let targetText: string | null
  try {
    targetText = await readTextOrNull(targetPath)
  } catch (error) {
    throw new McpAppSwitchError('target_unreadable', pick(`无法读取 pi 原生配置 ${targetPath}：${messageOf(error)}`, `Cannot read the pi native config ${targetPath}: ${messageOf(error)}`))
  }
  const targetDocument: unknown = targetText === null ? undefined : safeParse(targetText)
  if (targetText !== null && targetDocument === undefined) {
    throw new McpAppSwitchError('target_invalid_json', pick(`pi 原生配置不是合法 JSON（${targetPath}），拒绝改写`, `The pi native config is not valid JSON (${targetPath}); rewrite refused`))
  }

  const { collisions } = await inspectNativeLocations({ host, name: nativeName, targetPath })
  if (collisions.length > 0) {
    throw new McpAppSwitchError(
      'native_name_conflict',
      pick(`另有 pi 原生位置已有同名服务「${nativeName}」：${collisions.join('、')}；请先处理同名项再切换`, `Another pi native location already has a server named "${nativeName}": ${collisions.join(', ')}. Resolve the duplicate first`)
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
        pick(`pi 原生配置 ${targetPath} 里没有服务「${nativeName}」，没有可移出的条目`, `No server "${nativeName}" in the pi native config ${targetPath}; nothing to move out`)
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
    warnings.push(pick('原 pi 条目（含 env 等）已逐字保存到砚配置的 appHost.natives，回退时原样写回；请勿手动删除该记录。', 'The original pi entry (including env) is saved verbatim in appHost.natives of the Inkstone config and restored on fallback. Do not delete it.'))
    if (config.authRef?.trim()) {
      warnings.push(pick(`authRef「${config.authRef}」是砚侧凭证引用，不随条目迁移；砚托管连接仍需该凭证可用。`, `authRef "${config.authRef}" is an Inkstone-side credential reference and is not migrated; the Inkstone-hosted connection still needs it.`))
    }
  } else {
    const current = nativeEntryOf(targetDocument, nativeName)
    if (current.present) {
      throw new McpAppSwitchError('native_name_conflict', pick(`pi 原生配置已经有同名服务「${nativeName}」，拒绝覆盖`, `The pi native config already has a server named "${nativeName}"; overwrite refused`))
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
      warnings.push(pick(`authRef「${config.authRef}」是砚侧凭证引用，写回 pi 后请在 pi 里重新登录服务 ${nativeName}（pi mcp login ${nativeName}）。`, `authRef "${config.authRef}" is an Inkstone-side credential reference; after handing back to pi, sign in to ${nativeName} again in pi (pi mcp login ${nativeName}).`))
    }
    if (config.effect && config.effect !== 'unknown') {
      warnings.push(pick('effect 只作用于砚的权限判断，没有原生对应；pi 侧按工具注解与自身规则处理。', 'effect only applies to Inkstone permission checks and has no native equivalent; pi uses tool annotations and its own rules.'))
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
      pick(`同时待确认的切换已达上限（${MAX_PENDING_SWITCHES} 个），请先完成或等已过期的令牌释放后重试`, `Too many pending switches (${MAX_PENDING_SWITCHES}); finish one or wait for expired tokens to be released`)
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
    ? pick(`仍有 ${holders.length} 个已加载运行实例可能持有该服务；首版不自动重启。请先退出相关会话（或等其实例释放）后再切换。`, `${holders.length} loaded runtime(s) may still hold this server; no automatic restart. Exit the related sessions (or wait for release) first.`)
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

async function keepNativeOriginal(pending: PendingSwitch): Promise<string | null> {
  if (pending.targetOriginalText === null) return null
  const backup = `${pending.targetPath}.inkstone-backup-${Date.now()}`
  try {
    await writeFile(backup, pending.targetOriginalText, { encoding: 'utf8', flag: 'wx' })
    return backup
  } catch {
    return null
  }
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
    throw new McpAppSwitchError('host_config_unreadable', pick(`无法读取砚的 MCP 配置：${messageOf(error)}`, `Cannot read the Inkstone MCP config: ${messageOf(error)}`))
  }
  if (nativeMcpTextFingerprint(hostText) !== pending.hostFingerprint) {
    throw new McpAppSwitchError('host_changed', pick('预览后砚的 MCP 配置发生了变化，令牌已作废；请重新预览确认', 'The Inkstone MCP config changed after preview; token voided. Preview again'))
  }
  const parsed = parseMcpServersDocument(hostText ?? '', pending.hostConfigFile)
  if (parsed.error) throw new McpAppSwitchError('host_config_invalid', pick(`砚配置解析失败：${parsed.error}`, `Inkstone config parse failed: ${parsed.error}`))
  const config = parsed.servers.find((server) => server.id === pending.serverId)
  if (!config) throw new McpAppSwitchError('server_unknown', pick(`砚配置里已没有服务 ${pending.serverId}`, `Server ${pending.serverId} is no longer in the Inkstone config`))
  if (pending.direction === 'to-inkstone' && isInkstoneManaged(config)) {
    throw new McpAppSwitchError('already_managed', pick(`服务 ${pending.serverId} 已被砚托管，请重新预览`, `Server ${pending.serverId} is already hosted by Inkstone; preview again`))
  }
  if (pending.direction === 'to-pi' && !isInkstoneManaged(config)) {
    throw new McpAppSwitchError('not_managed', pick(`服务 ${pending.serverId} 已不是砚托管状态，请重新预览`, `Server ${pending.serverId} is no longer hosted by Inkstone; preview again`))
  }

  let targetText: string | null
  try {
    targetText = await readTextOrNull(pending.targetPath)
  } catch (error) {
    throw new McpAppSwitchError('target_unreadable', pick(`无法读取 pi 原生配置：${messageOf(error)}`, `Cannot read the pi native config: ${messageOf(error)}`))
  }
  if (nativeMcpTextFingerprint(targetText) !== pending.targetFingerprint) {
    throw new McpAppSwitchError('target_changed', pick('预览后 pi 原生配置发生了变化，令牌已作废；请重新预览确认', 'The pi native config changed after preview; token voided. Preview again'))
  }
  const present = targetText !== null && nativeEntryOf(safeParse(targetText), pending.nativeName).present
  if (pending.direction === 'to-inkstone' && !present) {
    throw new McpAppSwitchError('native_entry_missing', pick(`pi 原生配置里已没有服务「${pending.nativeName}」`, `Server "${pending.nativeName}" is no longer in the pi native config`))
  }
  if (pending.direction === 'to-pi' && present) {
    throw new McpAppSwitchError('native_name_conflict', pick(`pi 原生配置已有同名服务「${pending.nativeName}」，拒绝覆盖`, `The pi native config already has a server named "${pending.nativeName}"; overwrite refused`))
  }
  const { collisions } = await inspectNativeLocations({ host, name: pending.nativeName, targetPath: pending.targetPath })
  if (collisions.length > 0) {
    throw new McpAppSwitchError('native_name_conflict', pick(`另有 pi 原生位置已有同名服务：${collisions.join('、')}`, `Another pi native location already has a server with that name: ${collisions.join(', ')}`))
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
    if (!pending) throw new McpAppSwitchError('token_invalid', pick('切换令牌无效或已被使用，请重新预览', 'Switch token invalid or already used; preview again'))
    if (pending.expiresAt <= nowMs) {
      pendingSwitches.delete(token)
      throw new McpAppSwitchError('token_expired', pick('切换令牌已过期，请重新预览', 'Switch token expired; preview again'))
    }
    if (!owner || pending.ownerId !== owner.id) {
      throw new McpAppSwitchError('token_owner_mismatch', pick('切换令牌与调用者身份不匹配，拒绝执行', 'Switch token does not match the caller; refused'))
    }
    if (pending.agentDir !== host.agentDir || pending.hostConfigFile !== hostConfigPathOf(host)) {
      throw new McpAppSwitchError('host_mismatch', pick('切换令牌不是为当前宿主 / 数据目录生成的', 'Switch token was not issued for this host / data folder'))
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
          notice: pick(`${error instanceof McpAppSwitchError ? error.message : '无法确认运行时持有者'}；未做任何写入。`, `${error instanceof McpAppSwitchError ? error.message : 'Cannot confirm runtime holders'}. Nothing was written.`)
        }
      }
      if (resolved.holders.length > 0) {
        return {
          ...base,
          ok: false,
          steps: { ...skippedSteps(), hostDisconnect: 'not-needed' },
          remediation: 'not-needed',
          notice: pick(`仍有 ${resolved.holders.length} 个已加载运行实例可能持有该服务；首版不自动重启，已在写入前拒绝切换。请先退出相关会话。`, `${resolved.holders.length} loaded runtime(s) may still hold this server; no automatic restart, switch refused before writing. Exit the related sessions first.`)
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
        notice: pick(`写入前核对失败（${code}）：${messageOf(error)}；未做任何写入。`, `Pre-write check failed (${code}): ${messageOf(error)}. Nothing was written.`)
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
          notice: pick(`${error instanceof McpAppSwitchError ? error.message : '运行时复核失败'}；未做任何写入。`, `${error instanceof McpAppSwitchError ? error.message : 'Runtime recheck failed'}. Nothing was written.`)
        }
      }
    }

    if (pending.direction === 'to-pi' && !host.disconnectHost) {
      return {
        ...base,
        ok: false,
        steps: { ...skippedSteps(), hostDisconnect: 'skipped' },
        remediation: 'not-needed',
        notice: pick('宿主未提供断开砚连接的回调，无法确认唯一所有者，拒绝写回 pi（未做任何写入）。', 'The host provides no callback to disconnect Inkstone; cannot confirm a sole owner. Handback to pi refused (nothing written).')
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
          notice: pick(`断开砚宿主连接失败：${messageOf(error)}；未写入 pi 配置，砚托管保持原状。`, `Failed to disconnect the Inkstone host connection: ${messageOf(error)}. pi config not written; Inkstone hosting unchanged.`)
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
        notice: pick(`写入 pi 原生配置失败：${messageOf(error)}；砚配置未改动。`, `Failed to write the pi native config: ${messageOf(error)}. Inkstone config unchanged.`)
      }
    }

    try {
      await writeText(pending.hostConfigFile, pending.hostContent, pending.hostFingerprint)
    } catch (error) {
      const remediation = await restoreNative(writeText, pending)
      const backup = remediation === 'restored' ? null : await keepNativeOriginal(pending)
      const suffix =
        remediation === 'restored'
          ? pick('已用保存的原值把 pi 配置恢复回去。', 'pi config restored from the saved original.')
          : backup
            ? pick(`pi 配置的自动恢复失败，两边可能都不完整；原来的 pi 配置已另存到 ${backup}，可用它手动恢复。`, `Automatic pi config restore failed; both sides may be incomplete. The original pi config was saved to ${backup} for manual restore.`)
            : pick('pi 配置的自动恢复失败，两边可能都不完整，请按上方路径手动修复。', 'Automatic pi config restore failed; both sides may be incomplete. Repair manually using the path above.')
      return {
        ...base,
        ok: false,
        steps: { native: nativeStep, host: 'failed', verify: 'skipped', hostDisconnect },
        remediation,
        notice: pick(`写入砚配置失败：${messageOf(error)}；${suffix}`, `Failed to write the Inkstone config: ${messageOf(error)}. ${suffix}`)
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
        ? pick(`已把 ${pending.serverId} 从 pi 原生移出（${pending.targetPath}），并写入砚托管声明与回退条目。`, `Moved ${pending.serverId} out of pi native (${pending.targetPath}) and wrote the Inkstone hosting declaration and fallback entry.`)
        : pick(`已把 ${pending.serverId} 交回 pi 原生（${pending.targetPath}），砚条目已停用并标记 migratedToNative。`, `Handed ${pending.serverId} back to pi native (${pending.targetPath}); the Inkstone entry is disabled and marked migratedToNative.`)
    const verifyTail =
      verify === 'passed'
        ? pick('原生存在性复核通过。', 'Native presence check passed.')
        : verify === 'unavailable'
          ? pick('尚未接入 pi 原生存在性复核（宿主未注入 verify），已写入但未经运行确认。', 'Native presence check not wired (host did not inject verify); written but not confirmed at runtime.')
          : pick(`原生存在性复核未通过${verifyDetail ? `：${verifyDetail}` : ''}。`, `Native presence check failed${verifyDetail ? `: ${verifyDetail}` : ''}.`)
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
    ? pick('无法确认是否有运行实例仍持有该服务，已按不可切换处理（fail-closed）。', 'Cannot confirm whether a runtime still holds this server; treated as not switchable (fail-closed).')
    : blockedByHolders
      ? pick(`仍有 ${holders.length} 个已加载运行实例可能持有该服务；请先退出相关会话。`, `${holders.length} loaded runtime(s) may still hold this server; exit the related sessions first.`)
      : managed && !record
        ? pick('缺少 appHost 回退记录，不能在未保存原条目的情况下交回 pi。', 'No appHost fallback record; cannot hand back to pi without the original entry.')
        : undefined
  const inkstoneConnection = !managed && !config.migratedToNative && config.enabled !== false
  const inkstoneOnly = config.id === WINDOWS_MCP_SERVER_ID
  return {
    serverId: config.id,
    title: config.title ?? config.id,
    ownedBy: managed ? 'inkstone' : 'pi',
    managed,
    inkstoneConnection,
    inkstoneOnly,
    nativeName: record?.name ?? config.migratedToNative?.nativeName ?? config.id,
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
