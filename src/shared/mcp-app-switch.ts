/**
 * MCP 服务归属双向切换的共享协议（主进程与渲染端）。
 *
 * 一个服务只归一方连接：pi 原生（默认）或砚托管。切换是一次**带指纹校验的两文件事务**：
 * 从 pi 配置移出 + 砚配置接管（install），或从砚配置交回 + pi 配置写回（uninstall）。
 * 渲染端只拿得到脱敏预览与一次性令牌；真实条目（可能含 env / header / authRef）
 * 与文件路径始终由主进程持有，绝不随预览回传到模型或日志。
 *
 * 令牌、调用者身份、宿主路径与运行时是否安全都由主进程生成和核对，渲染端只能回传令牌。
 */

/** 切换方向：`to-inkstone` = pi → 砚托管；`to-pi` = 砚托管 → pi 原生。 */
export type McpAppSwitchDirection = 'to-inkstone' | 'to-pi'

/** 预览里对原生条目的**脱敏摘要**：只有白名单字段，且值一律不展示（env 只给键名、args 只给个数、url 只给 origin）。 */
export interface McpAppSwitchEntrySummary {
  transport: 'stdio' | 'http' | 'other'
  command: string | null
  argCount: number
  envKeys: string[]
  urlOrigin: string | null
  description: string | null
}

/** 已加载、可能仍持有该服务的运行实例。非空即禁止「立即切换」。 */
export interface McpAppSwitchHolder {
  runnerId: string
  generation: number
  /** 是否正在跑回合（比空闲加载更危险）。 */
  busy: boolean
}

/** 写盘前展示给用户的预览；不含令牌之外的任何机密内容。 */
export interface McpAppSwitchPreview {
  token: string
  expiresAt: string
  direction: McpAppSwitchDirection
  serverId: string
  nativeName: string
  scope: 'global' | 'project'
  projectId?: string
  /** pi 侧目标文件（全局 `mcp.json` 或项目 `.pi/mcp.json`）。 */
  targetPath: string
  /** 砚侧配置文件。 */
  hostConfigFile: string
  /** 将被移走 / 写回的原生条目的脱敏摘要。 */
  entry: McpAppSwitchEntrySummary
  warnings: string[]
  /** 有已加载运行实例时禁止立即切换（首版不自动重启）。 */
  blocked: boolean
  blockedReason?: string
  holders: McpAppSwitchHolder[]
}

/** 提交的分步结果；`partial` 语义由 `steps` + `remediation` 如实表达。 */
export interface McpAppSwitchCommitResult {
  ok: boolean
  direction: McpAppSwitchDirection
  serverId: string
  nativeName: string
  targetPath: string
  hostConfigFile: string
  steps: {
    /** pi 侧：`to-inkstone` 移除条目；`to-pi` 写回条目。 */
    native: 'removed' | 'written' | 'failed' | 'skipped'
    /** 砚侧：`to-inkstone` 写托管声明；`to-pi` 写停用 / 迁移标记。 */
    host: 'enrolled' | 'released' | 'failed' | 'skipped'
    /** pi 原生存在性复核（expect present / absent）。 */
    verify: 'passed' | 'failed' | 'unavailable' | 'skipped'
    /** `to-pi` 提交前断开砚宿主连接。 */
    hostDisconnect: 'disconnected' | 'failed' | 'skipped' | 'not-needed'
  }
  /** 写盘后失败时的补救状态：`restored` 表示已按保存的原值写回，`remediation-failed` 表示「两边都可能不完整」。 */
  remediation: 'not-needed' | 'restored' | 'remediation-failed' | 'unknown'
  notice: string
  warnings: string[]
}

/** IPC 预览响应：失败是**可展示的错误**，不是异常。 */
export interface McpAppSwitchPrepareResponse {
  ok: boolean
  preview?: McpAppSwitchPreview
  code?: string
  error?: string
}

/**
 * IPC 提交响应。`ok:false` 且没有 `result`：提交在写盘前就被拒（令牌 / 身份 / 运行时变化）；
 * `ok:true`：拿到了分步结果，此时要按 `result.steps` 与 `result.remediation` 如实展示部分失败。
 */
export interface McpAppSwitchCommitResponse {
  ok: boolean
  result?: McpAppSwitchCommitResult
  code?: string
  error?: string
}

/** 设置页每个服务的归属只读投影（不含任何凭证与完整条目）。 */
export interface McpAppOwnershipView {
  serverId: string
  title: string
  ownedBy: 'pi' | 'inkstone'
  managed: boolean
  nativeName: string
  scope: 'global' | 'project'
  projectScoped: boolean
  /** 砚配置里保存了回退用的原条目。 */
  hasNativeRecord: boolean
  enabled: boolean
  /** 已加载、可能持有该服务的运行实例；非空时禁止立即切换。 */
  holders: McpAppSwitchHolder[]
  canSwitch: boolean
  blockedReason?: string
  /** 首版不支持托管的原因（`windows-mcp` 等）。 */
  unsupportedReason?: string
}

/**
 * 只读归属视图的 IPC 响应。
 *
 * 主进程即使在砚配置损坏时也返回**对象**（`error` 非空、`servers` 为空数组），
 * 渲染端必须按对象解包：不能把「拿到数组」当作成功，也不能把任意对象静默当作空列表。
 * `servers: []` + 无 `error` 才是「当前实例看不到可切换服务」的正常空状态。
 */
export interface McpAppOwnershipResponse {
  servers: McpAppOwnershipView[]
  error?: string
}

/** 原生存在性校验输入（与导入的校验分开，避免 host-switch 依赖 shared/mcp-native-import）。 */
export interface McpAppSwitchVerifyInput {
  serverId: string
  nativeName: string
  scope: 'global' | 'project'
  targetPath: string
  /** commit 用本次刚写入的完整文本算出的 SHA256；verifier 必须先核对此指纹再动作。 */
  expectedFingerprint: string
  expect: 'present' | 'absent'
  projectId?: string
  projectCwd?: string
}

/** 原生存在性校验结果；`ok:false` 时 `detail` 说明原因（不因此回滚已写盘的事实）。 */
export interface McpAppSwitchVerifyResult {
  ok: boolean
  detail?: string
  connected?: boolean
  toolCount?: number
}

/** 渲染端归属切换桥（preload 白名单；主进程按主窗口校验调用来源）。 */
export interface McpAppBridge {
  /** 只读归属视图；不连接、不落盘。失败是响应的 `error` 字段，不是「空列表」。 */
  ownership(): Promise<McpAppOwnershipResponse>
  /** 只读预览 + 生成一次性令牌；不落盘、不连接。 */
  prepareSwitch(serverId: string): Promise<McpAppSwitchPrepareResponse>
  /** 用户明确确认后提交；令牌只能来自 prepareSwitch。 */
  commitSwitch(token: string): Promise<McpAppSwitchCommitResponse>
}

/** 只取 http/https 的 origin（协议 + 主机 + 端口），剔除 userinfo / query / path / hash。 */
export function mcpAppHttpOriginOf(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  return url.origin
}

/**
 * 从原生条目提取白名单摘要。只读已知字段：
 * `description` / `command` 是可读文本；`args` 只给个数；`env` 只给键名；
 * `url` 只给 http(s) origin；未知字段（含嵌套对象）一律不进入摘要。
 */
export function summarizeMcpAppNativeEntry(entry: unknown): McpAppSwitchEntrySummary {
  const record = entry && typeof entry === 'object' && !Array.isArray(entry) ? (entry as Record<string, unknown>) : null
  if (!record) {
    return { transport: 'other', command: null, argCount: 0, envKeys: [], urlOrigin: null, description: null }
  }
  const args = Array.isArray(record.args) ? record.args : []
  const env =
    record.env && typeof record.env === 'object' && !Array.isArray(record.env)
      ? (record.env as Record<string, unknown>)
      : null
  const command = typeof record.command === 'string' && record.command.trim() !== '' ? record.command : null
  const transport: McpAppSwitchEntrySummary['transport'] =
    typeof record.url === 'string' && record.url.trim() !== '' ? 'http' : command ? 'stdio' : 'other'
  return {
    transport,
    command,
    argCount: args.length,
    envKeys: env ? Object.keys(env).sort() : [],
    urlOrigin: mcpAppHttpOriginOf(record.url),
    description:
      typeof record.description === 'string' && record.description.trim() !== '' ? record.description : null
  }
}
