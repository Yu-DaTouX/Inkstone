/**
 * 旧宿主 MCP → pi 原生 `mcp.json` 的纯转换与共享协议。
 *
 * 这里只做判断与变换：哪些服务不迁、原生条目形状、同名碰撞、停用标记怎么落回旧配置；
 * 读写文件、短效令牌与校验回调在 `src/main/mcp/native-import.ts`。渲染端只引用类型，
 * 令牌、宿主路径与调用者身份始终由主进程生成和核对。
 *
 * 原生 schema 以随包 pi 的实现为准：全局 `<PI_AGENT_DIR>/mcp.json`、项目
 * `<cwd>/.pi/mcp.json`，形状 `{ mcpServers: { <name>: {...} } }`；服务名只允许
 * 字母、数字、`_`、`-`（`mcpNamespace` 再把 `-` 换成 `_` 拼出 `mcp__*` 工具名）。
 */
import type { McpMigratedToNativeMark, McpServerConfig } from './mcp'

/** 电脑操作使用的受管服务，留在砚的连接里，不导入。 */
export const WINDOWS_MCP_SERVER_ID = 'windows-mcp'

const NATIVE_SERVER_NAME = /^[A-Za-z0-9_-]+$/

/** pi 侧的服务名约束：不合法就拒绝导入，**不**自动改名（改名会改变工具名与清单）。 */
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

/**
 * 把一条砚的 MCP 服务转成 pi 原生条目。
 *
 * `authRef` 是砚里的凭证引用，按约定**不迁移**：不写进原生文件，只提示重新登录。
 * `effect` 没有原生对应（pi 按工具注解与自身规则判断），只作为警告带出。
 */
export function convertMcpServerToNative(config: McpServerConfig): McpNativeConversion {
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

/** 合并进 pi 原生文档：保留未知顶层字段与其他服务条目；同名一律拒绝覆盖。 */
export function buildNativeMcpDocument(options: {
  existing: unknown
  name: string
  server: Record<string, unknown>
}): { ok: true; document: Record<string, unknown> } | { ok: false; code: 'target_shape' | 'name_conflict'; reason: string } {
  const { existing, name, server } = options
  if (existing === undefined) {
    return { ok: true, document: { mcpServers: { [name]: server } } }
  }
  /*
   * 文件存在但内容是 JSON `null`：这是坏配置，不是「没有配置」。
   * pi 期望顶层是对象，把它当空文档覆盖等于替用户丢掉一份坏掉的配置，
   * 所以必须拒绝，由用户先修复或删除原文件。
   */
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

/**
 * 在旧配置文档里给一条服务打停用 + 迁移标记（`enabled: false`，不删除、不动其它字段）。
 * 同时兼容 `[...]` 与 `{ servers: [...] }` 两种已支持的形状。
 */
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

/*
 * ── 导入的一对一协议（主进程与渲染端共用；渲染端只引用类型，不引 main）──
 *
 * 预览与提交结果都需要展示给用户确认，所以类型放在 shared；令牌、宿主路径与身份
 * 绑定始终由主进程生成与核对，渲染端只能回传令牌。
 */

/** 校验回调的输入：由主进程从冻结的预览数据补全，渲染端无法指定路径或身份。 */
export interface NativeMcpImportVerifyInput {
  serverId: string
  nativeName: string
  scope: 'global' | 'project'
  targetPath: string
  /**
   * commit 用**本次刚写入的完整文本**算出的 SHA256。verifier 必须先用它核对从
   * targetPath 一次读到的文本，再从同一文本里取这一条服务；不符或缺此依据一律
   * 判未通过且不 spawn。它由主进程生成，渲染端/模型不能提供。
   */
  expectedFingerprint: string
  projectId?: string
  projectCwd?: string
}

/** 校验回调的结果；`ok` 为 false 时 `detail` 说明原因（旧条目不会停用）。 */
export interface NativeMcpImportVerifyResult {
  ok: boolean
  detail?: string
  connected?: boolean
  toolCount?: number
}

export type NativeMcpImportVerification = 'passed' | 'failed' | 'unavailable'

/** 写进原生文件前展示给用户的预览（`content` 就是将要落盘的完整 JSON 文本）。 */
export interface NativeMcpImportPreview {
  token: string
  expiresAt: string
  serverId: string
  nativeName: string
  scope: 'global' | 'project'
  projectId?: string
  projectCwd?: string
  /** 目标文件：全局 `<agentDir>/mcp.json` 或项目 `<cwd>/.pi/mcp.json`。 */
  targetPath: string
  /** 将写入的完整 JSON 文本（预览用）。 */
  content: string
  /** 只新增这一条原生服务条目。 */
  serverEntry: Record<string, unknown>
  warnings: string[]
  requiresReauth: boolean
  reauthNotice?: string
}

/** 提交的分步结果；`nativeWritten` 为 true 时即使其它步骤失败也已写入原生文件。 */
export interface NativeMcpImportCommitResult {
  /** 原生写入、校验、停用旧条目都成功才为 true。 */
  ok: boolean
  serverId: string
  nativeName: string
  targetPath: string
  /** 原生配置是否已写入。 */
  nativeWritten: boolean
  /** 旧条目是否已停用（写入 `migratedToNative` + `enabled: false`）。 */
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

/** IPC 预览响应：失败是**可展示的错误**，不是异常。 */
export interface NativeMcpImportPrepareResponse {
  ok: boolean
  preview?: NativeMcpImportPreview
  code?: string
  error?: string
}

/**
 * IPC 提交响应。`ok:false` 且没有 `result` 表示提交在写盘前就被拒（令牌/身份/并发变化）；
 * `ok:true` 表示拿到了分步结果，此时要按 `result.steps` 与 `result.ok` 如实展示部分失败。
 */
export interface NativeMcpImportCommitResponse {
  ok: boolean
  result?: NativeMcpImportCommitResult
  code?: string
  error?: string
}

/** `yan mcp` 对已迁移服务给出的可读提示（也用于重复导入的说明）。 */
export function migratedMcpCommandNotice(serverId: string, mark: McpMigratedToNativeMark): string {
  const nativeName = mark.nativeName?.trim() || serverId
  const toolPattern = `mcp__${nativeName.replace(/-/g, '_')}__*`
  return (
    `MCP 服务 ${serverId} 已导入 pi 原生（写入 ${mark.targetPath}），yan mcp describe / call 不再驱动它；` +
    `请改用 pi 原生工具 ${toolPattern}。要回退旧命令，先移除旧配置里的 migratedToNative 标记并重新启用。`
  )
}
