import type { McpMigratedToNativeMark, McpServerConfig } from './mcp'

export const WINDOWS_MCP_SERVER_ID = 'windows-mcp'

export interface NativeMcpServerView {
  name: string
  scope: 'global' | 'project'
  path: string
  transport: 'stdio' | 'http'
  command?: string
  argCount: number
  endpointOrigin?: string
  exposure?: string
  enabled: boolean
  overriddenBy?: string
}

export interface NativeMcpServerListView {
  servers: NativeMcpServerView[]
  globalPath: string
  projectPath?: string
  projectUntrusted?: boolean
  errors?: string[]
}

const NATIVE_SERVER_NAME = /^[A-Za-z0-9_-]+$/

export function nativeMcpServerName(id: string): { ok: true; name: string } | { ok: false; reason: string } {
  const name = id.trim()
  if (!name) return { ok: false, reason: '服务 id 为空，不能作为 pi 原生服务名' }
  if (!NATIVE_SERVER_NAME.test(name)) {
    return {
      ok: false,
      reason: `服务 id「${id}」含 pi 不接受的字符（只允许字母、数字、_ 和 -）；不会自动改名，请先在砚里改名`
    }
  }
  return { ok: true, name }
}

export type McpNativeConversion =
  | { ok: true; server: Record<string, unknown>; warnings: string[]; requiresReauth: boolean }
  | { ok: false; reason: string }

export function convertMcpServerToNative(config: McpServerConfig): McpNativeConversion {
  if (config.projectEnabled && Object.keys(config.projectEnabled).length) return { ok: false, reason: '此服务存在项目开关覆盖，请先在项目设置中恢复全局设置，再切换连接方式' }
  if (config.id === WINDOWS_MCP_SERVER_ID) {
    return { ok: false, reason: 'windows-mcp 保留在砚的连接里（电脑操作需要排队与用户接管），不导入 pi 原生' }
  }
  const named = nativeMcpServerName(config.id)
  if (!named.ok) return named

  const warnings: string[] = []
  let requiresReauth = false
  const server: Record<string, unknown> = {}
  if (config.title?.trim()) server.description = config.title.trim()

  if (config.transport === 'stdio') {
    if (!config.command?.trim()) return { ok: false, reason: `${config.id}: stdio 缺少 command，拒绝生成原生条目` }
    server.command = config.command
    if (config.args && config.args.length > 0) server.args = [...config.args]
    if (config.env && Object.keys(config.env).length > 0) server.env = { ...config.env }
  } else if (config.transport === 'http') {
    if (!config.url?.trim()) return { ok: false, reason: `${config.id}: http 缺少 url，拒绝生成原生条目` }
    server.url = config.url
  } else {
    return { ok: false, reason: `${config.id}: 不认识的 transport（${String(config.transport)}）` }
  }

  if (config.authRef?.trim()) {
    requiresReauth = true
    warnings.push(
      `authRef「${config.authRef}」是砚里的凭证引用，按约定不迁移；导入后需要在 pi 里重新登录服务 ${config.id}`
    )
  }
  if (config.effect && config.effect !== 'unknown') {
    warnings.push('旧配置里的 effect 只作用于砚的权限判断，没有原生对应；pi 侧按工具注解与自身规则处理')
  }
  if (config.projectScope?.trim()) {
    warnings.push('项目级 .pi/mcp.json 只有在 pi 信任该目录后才会被读取；目录未信任时这份导入不会生效')
  }
  return { ok: true, server, warnings, requiresReauth }
}

export function buildNativeMcpDocument(options: {
  existing: unknown
  name: string
  server: Record<string, unknown>
}): { ok: true; document: Record<string, unknown> } | { ok: false; code: 'target_shape' | 'name_conflict'; reason: string } {
  const { existing, name, server } = options
  if (existing === undefined) {
    return { ok: true, document: { mcpServers: { [name]: server } } }
  }
  if (existing === null) {
    return { ok: false, code: 'target_shape', reason: 'pi 原生 mcp.json 解析结果是 JSON null（坏配置），拒绝覆盖' }
  }
  if (typeof existing !== 'object' || Array.isArray(existing)) {
    return { ok: false, code: 'target_shape', reason: 'pi 原生 mcp.json 顶层必须是 JSON 对象' }
  }
  const record = existing as Record<string, unknown>
  const current = record.mcpServers
  if (current !== undefined && (typeof current !== 'object' || current === null || Array.isArray(current))) {
    return { ok: false, code: 'target_shape', reason: 'pi 原生 mcp.json 里的 mcpServers 必须是对象，拒绝改写成其它形状' }
  }
  const servers = (current ?? {}) as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(servers, name)) {
    return { ok: false, code: 'name_conflict', reason: `pi 原生 mcp.json 已经有同名服务「${name}」，拒绝覆盖` }
  }
  return { ok: true, document: { ...record, mcpServers: { ...servers, [name]: server } } }
}

export function applyMigratedMark(options: {
  document: unknown
  serverId: string
  mark: McpMigratedToNativeMark
}): { ok: true; document: unknown } | { ok: false; reason: string } {
  const { document, serverId, mark } = options
  const patchEntry = (entry: unknown): { hit: boolean; value: unknown } => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { hit: false, value: entry }
    const record = entry as Record<string, unknown>
    if (record.id !== serverId) return { hit: false, value: entry }
    return { hit: true, value: { ...record, enabled: false, migratedToNative: mark } }
  }
  const missing = { ok: false as const, reason: `旧配置里没有 id 为 ${serverId} 的条目` }

  if (Array.isArray(document)) {
    let found = false
    const next = document.map((entry) => {
      const patched = patchEntry(entry)
      if (patched.hit) found = true
      return patched.value
    })
    return found ? { ok: true, document: next } : missing
  }
  if (!document || typeof document !== 'object') return { ok: false, reason: '旧 MCP 配置不是对象或数组，拒绝改写' }
  const record = document as Record<string, unknown>
  if (!Array.isArray(record.servers)) return { ok: false, reason: '旧 MCP 配置里的 servers 不是数组，拒绝改写' }
  let found = false
  const next = record.servers.map((entry) => {
    const patched = patchEntry(entry)
    if (patched.hit) found = true
    return patched.value
  })
  return found ? { ok: true, document: { ...record, servers: next } } : missing
}

export interface NativeMcpImportVerifyInput {
  serverId: string
  nativeName: string
  scope: 'global' | 'project'
  targetPath: string
  expectedFingerprint: string
  projectId?: string
  projectCwd?: string
}

export interface NativeMcpImportVerifyResult {
  ok: boolean
  detail?: string
  connected?: boolean
  toolCount?: number
}

export type NativeMcpImportVerification = 'passed' | 'failed' | 'unavailable'

export interface NativeMcpImportPreview {
  token: string
  expiresAt: string
  serverId: string
  nativeName: string
  scope: 'global' | 'project'
  projectId?: string
  projectCwd?: string
  targetPath: string
  content: string
  serverEntry: Record<string, unknown>
  warnings: string[]
  requiresReauth: boolean
  reauthNotice?: string
}

export interface NativeMcpImportCommitResult {
  ok: boolean
  serverId: string
  nativeName: string
  targetPath: string
  nativeWritten: boolean
  deactivated: boolean
  verified: boolean
  verification: NativeMcpImportVerification
  steps: {
    nativeWrite: 'written' | 'failed' | 'skipped'
    verify: NativeMcpImportVerification | 'skipped'
    hostDisable: 'disabled' | 'skipped' | 'skipped-external-change' | 'failed'
  }
  notice: string
  warnings: string[]
}

export interface NativeMcpImportPrepareResponse {
  ok: boolean
  preview?: NativeMcpImportPreview
  code?: string
  error?: string
}

export interface NativeMcpImportCommitResponse {
  ok: boolean
  result?: NativeMcpImportCommitResult
  code?: string
  error?: string
}

export function migratedMcpCommandNotice(serverId: string, mark: McpMigratedToNativeMark): string {
  const nativeName = mark.nativeName?.trim() || serverId
  const toolPattern = `mcp__${nativeName.replace(/-/g, '_')}__*`
  return (
    `MCP 服务 ${serverId} 已导入 pi 原生（写入 ${mark.targetPath}），yan mcp describe / call 不再驱动它；` +
    `请改用 pi 原生工具 ${toolPattern}。要回退旧命令，先移除旧配置里的 migratedToNative 标记并重新启用。`
  )
}
