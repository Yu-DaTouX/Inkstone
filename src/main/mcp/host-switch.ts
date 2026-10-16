/**
 * MCP 服务归属的**双向切换事务**：pi 原生 ⇄ 砚托管。
 *
 * ── 它是什么 ──
 *   一个服务只归一方连接。切换不是「改一个开关」，而是两份文件的一次事务：
 *     · `to-inkstone`（pi → 砚托管）：从 pi 的 `mcp.json` 移出该条目，再在砚配置里
 *       写 `ownedBy:'inkstone'` + `appHost.natives[]`（逐字保存原条目供回退）；
 *     · `to-pi`（砚托管 → pi 原生）：把 `appHost.natives[]` 里的原条目写回 pi 文件，
 *       砚条目恢复 `enabled:false + ownedBy:'pi' + migratedToNative`。
 *
 * ── 安全边界（与 `native-import.ts` 同一套）──
 *   · `prepare` 只读预览并发放**绑定调用者身份**的短效令牌，不落盘、不连接；
 *   · `commit` 在**共享串行写链**里核对令牌 / 身份 / 两份文件指纹 / 有效期后写入；
 *   · 未知字段保留；写入前后都读文件核对指纹，外部改动一律拒绝；
 *   · 任何写后失败都如实回报 `steps` 与 `remediation`，绝不报告「完全未改」；
 *   · 原始 pi 条目只进砚配置的 `appHost.natives[]`，**不随预览回传渲染端**。
 *
 * ── 杜绝双连接 ──
 *   移除配置不等于停掉旧进程。首版只要存在**可能仍持有该服务的已加载 runner**，
 *   就拒绝 `to-inkstone` 的立即切换（由宿主注入的 `holders` 运行时守卫判定），
 *   不自动重启、不为了通过而删服务。`to-pi` 则在写盘前先断开砚宿主连接。
 */
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

/** 受信项目登记：`projectId → cwd` 只由宿主提供，不按目录反推。 */
export interface McpAppSwitchProject {
  id: string
  cwd: string
}

/**
 * 运行时守卫：返回**已加载、可能仍持有该服务**的运行实例。
 *
 * 非空即禁止 `to-inkstone` 立即切换 —— 配置移走不代表旧 pi 进程已停，
 * 首版不自动重启，宁可让用户先退出相关会话/重启。
 */
export interface McpAppSwitchHolderProvider {
  holdersFor(server: {
    serverId: string
    scope: 'global' | 'project'
    projectId?: string
  }): Promise<McpAppSwitchHolder[]>
  /**
   * 实例集合 / 身份 / 连接事实的 epoch（可选但强烈建议）。
   * `commit` 会在关键写入前复核；变了说明检查之后有新实例进入或进程状态改变。
   */
  runtimeEpoch?(): string
}

export interface McpAppSwitchOwner {
  id: string
}

export interface McpAppSwitchHost {
  /** pi 的 agent 目录（`PI_AGENT_DIR`）。 */
  agentDir: string
  /** 砚 MCP 配置路径；缺省 `YAN_MCP_SERVERS_FILE` / `YAN_DIR/mcp-servers.json`。 */
  hostConfigFile?: string
  projects: readonly McpAppSwitchProject[]
  /** 运行时守卫；缺省视为「无已加载实例」（测试可注入）。 */
  holders?: McpAppSwitchHolderProvider
  /**
   * `to-pi` 写盘前确认断开砚宿主的**目标服务**（只断该 server，不关整个连接池，
   * 不影响其它服务 / 其它会话）。缺省跳过（由调用方保证）。
   */
  disconnectHost?: (serverId: string) => Promise<void>
  /** 写完 pi 配置后的存在性校验。缺省不校验，结果标 `unavailable`。 */
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
  /** 失败补救用：native 文件的原始文本（null = 原文件不存在）。 */
  targetOriginalText: string | null
  /** 失败补救用：砚配置的原始文本。 */
  hostOriginalText: string
  warnings: string[]
  targetFingerprint: string
  hostFingerprint: string
  /** 预览时捕获的运行时 epoch；写盘前复核对得上才算一致。 */
  guardEpoch?: string
  expiresAt: number
}

/** 同时待确认的切换上限：防止反复 preview 只生成令牌而不确认。 */
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

/* ------------------------------------------------------------------ */
/* 纯文档变换（保留未知字段；不做 IO）                                  */
/* ------------------------------------------------------------------ */

/** 首版不纳入托管的服务；返回原因供 UI 解释。 */
export function mcpAppUnsupportedReason(config: McpServerConfig): string | undefined {
  if (config.id === WINDOWS_MCP_SERVER_ID) {
    return 'windows-mcp 保留在砚的连接里（电脑操作需要排队与用户接管），首版不纳入托管'
  }
  if (config.transport !== 'stdio' && config.transport !== 'http') {
    return `不支持的 transport：${String(config.transport)}`
  }
  return undefined
}

/** 砚配置里保存的原 pi 条目（回退用）。 */
export function mcpAppNativeRecord(config: McpAppServerConfig): McpAppNativeEntry | undefined {
  return config.appHost?.natives?.[0]
}

/** 当前服务此刻的归属：托管必须 `ownedBy:'inkstone'` + `appHost` + 未禁用。 */
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

/** 在砚文档里写托管声明（`to-inkstone`）：启用 + `ownedBy:'inkstone'` + `appHost`。 */
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

/** 在砚文档里写回退标记（`to-pi`）：停用 + `ownedBy:'pi'` + `migratedToNative`，并移除 `appHost`。 */
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

/** 从 pi 文档移除一条服务（保留其它服务与未知顶层字段）。 */
function removeNativeEntry(document: unknown, name: string): { ok: true; document: unknown } | { ok: false; reason: string } {
  const root = asRecord(document)
  if (!root) return { ok: false, reason: 'pi 原生配置顶层必须是 JSON 对象' }
  const servers = asRecord(root.mcpServers)
  if (!servers) return { ok: false, reason: 'pi 原生配置里的 mcpServers 必须是对象' }
  const next = { ...servers }
  delete next[name]
  return { ok: true, document: { ...root, mcpServers: next } }
}

/** 把一条服务插入 pi 文档（同名一律拒绝；文件不存在时新建）。 */
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

/* ------------------------------------------------------------------ */
/* 位置扫描（项目范围 / 全局同名项都须检查）                            */
/* ------------------------------------------------------------------ */

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

/** 扫描所有原生位置：目标位置是否已含该名字、其它位置是否有同名（歧义）。 */
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

/* ------------------------------------------------------------------ */
/* 运行时守卫（fail-closed）                                            */
/* ------------------------------------------------------------------ */

interface HolderQuery {
  serverId: string
  scope: 'global' | 'project'
  projectId?: string
}

/**
 * 读取运行时持有者。**任何不确定都拒绝**：
 *   · provider 缺失 → 无法判断；
 *   · epoch 读取抛错 → 无法在写前复核；
 *   · holdersFor 抛错或返回非数组 → 无法确认无人持有。
 * 全部转成 `holders_unavailable`，绝不当作「无人持有」。
 */
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

/** 写盘前复核：provider 仍需可用、仍无持有者、epoch 未变，否则抛错拒绝。 */
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

/* ------------------------------------------------------------------ */
/* prepare                                                             */
/* ------------------------------------------------------------------ */

/**
 * 只读预览 + 生成一次性令牌：读两份文件、算指纹、构造将写入的内容。
 * 不落盘、不停用、不连接任何服务；原始 pi 条目留在令牌里只供宿主使用。
 */
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

  /* 范围与目标位置：托管条目以 appHost 记录为准（那是当初移出的位置）。 */
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

  /* 同名冲突：项目范围 / 全局都须检查；歧义时绝不静默挑一个。 */
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

  /* 运行时守卫：to-inkstone 必须能确认「谁可能仍持有」；缺失 / 异常都拒绝，不当作无人持有。 */
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

/* ------------------------------------------------------------------ */
/* commit                                                              */
/* ------------------------------------------------------------------ */

function skippedSteps(): McpAppSwitchCommitResult['steps'] {
  return { native: 'skipped', host: 'skipped', verify: 'skipped', hostDisconnect: 'skipped' }
}

/** 写盘后失败时，用保存的原始文本把 native 文件恢复回去。 */
async function restoreNative(
  writeText: (path: string, text: string, expectedFingerprint?: string) => Promise<void>,
  pending: PendingSwitch
): Promise<McpAppSwitchCommitResult['remediation']> {
  try {
    const current = await readTextOrNull(pending.targetPath)
    const currentFingerprint = nativeMcpTextFingerprint(current)
    if (currentFingerprint !== nativeMcpTextFingerprint(pending.targetContent)) {
      /* 目标已被外部改动，不敢覆盖；显式保留修复入口。 */
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

/** 提交：共享串行写链内核对令牌 / 身份 / 两份指纹后写入，并按分步结果如实回报。 */
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
    /* 领取：自此同一令牌不能再用；写入失败也要重新 preview。 */
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

    /* 1. to-inkstone：provider 缺失 / 无法判断 / 仍有存活实例都拒绝立即切换（不自动重启）。 */
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

    /* 2. 写前核对两份文件与状态。 */
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

    /*
     * 2.5 写前复核运行时：precheck 是 await，期间可能有新实例进入或进程状态改变。
     * 预览时的检查不算数，关键写入前必须再看一次 epoch / 持有者。
     */
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

    /* 3. to-pi：先把砚宿主连接断掉，确认唯一所有者后再写 pi。缺回调直接拒绝，不写盘。 */
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

    /* 4. 写 pi 文件。 */
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

    /* 5. 写砚配置；失败则按保存的原值恢复 pi 文件。 */
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

    /* 6. 复核 pi 侧存在性。 */
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

/** 只读归属视图：给设置页判断能否切换与展示原因（不连接、不落盘）。 */
export function mcpAppOwnershipView(input: {
  config: McpAppServerConfig
  holders: McpAppSwitchHolder[]
  projectScoped: boolean
  /** 运行时持有情况无法判断（注册表缺失 / 异常）→ to-inkstone 按不可切换处理。 */
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
