/**
 * MCP App 视图桥的共享契约（主进程宿主 / 渲染端 / 单测共用）。
 *
 * ── 它是什么 ──
 *   一次模型工具调用（`mcp__<server>__<tool>`）返回 `_meta.ui.resourceUri` 后，宿主
 *   把该 URI 对应的 App 页面缓存成实例，渲染端在对应步骤下方用 iframe 显示。渲染端
 *   与宿主之间只有这条窄桥：
 *     · `prepare(callId)`：按**模型工具调用记录**准备一个实例；渲染端不提供 URL /
 *       serverId，也不提供 owner / grant / 权限档；
 *     · `dispatch(instanceId, message)`：转发 App 自己发来的 JSON-RPC 小包；
 *     · `release(instanceId)`：卸载某个实例（不影响其它实例 / 其它会话）；
 *     · `audit(callId)`：读取本次调用已**真实落盘**的审计摘要，供步骤 UI 渲染；
 *     · `snapshot()` / `refresh()`：宿主工具快照的只读状态与显式刷新。
 *
 * ── 安全边界（主进程负责，渲染端只传最小标识）──
 *   · 身份（前台 runner / sessionFile / generation / projectId / 权限档 / 授权）一律
 *     由主进程从实际运行实例派生，渲染端传什么都不影响授权；
 *   · `prepare` 只认当前宿主 owner 已有的模型调用记录；历史恢复没有本机结果时只给
 *     文本回退，**绝不**因此重跑 `tools/call`；
 *   · App 发起的调用走与模型同口径的注解审批 + 宿主服务器授权；审计必须先真实写入，
 *     写入失败就不执行。
 *
 * 规范字段名（`ui/*` 方法、`_meta.ui`）不在本文件猜；主进程从 `src/main/mcp/app-spec.ts`
 * 唯一来源取值，该模块仍标注「待按稳定版规范核对」。
 */

/** `prepare` 成功：已缓存一个可以渲染的 App 页面。 */
export interface McpAppViewReadyDescriptor {
  kind: 'ready'
  /** 本次准备产生的实例号；只用于 `dispatch` / `release`，不是授权凭据。 */
  instanceId: string
  /** 受控 `inkstone-app:` 地址；渲染端仍须自行 `parseMcpAppUrl` 校验。 */
  url: string
  /** 显示标题（服务标题 / 工具名），仅供界面使用。 */
  title: string
  /** 触发本实例的模型工具调用 id。 */
  callId: string
}

/** 没有可渲染的 App：给文本回退（历史恢复、无 resourceUri、资源读取失败等）。 */
export interface McpAppViewTextDescriptor {
  kind: 'text'
  /** 已记录的模型可见文本（可能为空）。 */
  text: string
  /** 为什么不渲染 App；给界面说明用，不含凭据 / 原始 Meta。 */
  reason: string
}

/** 明确失败：无可用运行实例、身份/归属不符、实例数超限等。 */
export interface McpAppViewErrorDescriptor {
  kind: 'error'
  error: string
}

export type McpAppViewDescriptor =
  | McpAppViewReadyDescriptor
  | McpAppViewTextDescriptor
  | McpAppViewErrorDescriptor

/** App 调用审计的阶段；一次 `tools/call` 依次产生 requested → approved/denied → completed/error。 */
export type McpAppViewAuditPhase = 'requested' | 'denied' | 'approved' | 'completed' | 'error'

/**
 * 一条**已持久化**的 App 调用审计摘要。
 *
 * 只放安全摘要：绝不含原始凭据、完整 args、原始 `_meta` / `structuredContent`。
 * `argsHash` 是规范化参数的哈希，用来对账而不回放内容。
 */
export interface McpAppViewAuditEntry {
  id: string
  at: number
  /** 触发本 App 实例的模型工具调用 id（同一次视图下多次 App 调用共享它）。 */
  callId: string
  /** 被调用的 MCP 工具名（不含 `mcp__` 前缀）。 */
  toolName: string
  phase: McpAppViewAuditPhase
  permissionMode: 'all' | 'danger'
  summary: string
  serverId?: string
  instanceId?: string
  /** 规范化参数的 sha256（可选）；不是原文。 */
  argsHash?: string
  /** 拒绝 / 失败原因（可选）。 */
  reason?: string
}

export interface McpAppViewSnapshot {
  needsRefresh: boolean
  toolCount: number
}

export interface McpAppViewRefreshResult {
  ok: boolean
  toolCount: number
  error?: string
}

/**
 * `YanBridge.mcpApps` 的形状。
 *
 * 主进程身份始终从实际前台 runner / session 派生；renderer 只传 callId / instanceId /
 * JSON-RPC 消息，**不得**传 owner / grant / permission 以决定授权。`snapshot` / `refresh`
 * 的「当前项目」也由宿主 runtime 事实提供：项目目标刷新只连全局 + 本项目，缺可信
 * caller 时项目目标一律不连（不从目标配置的 `projectScope` 自证）。
 */
export interface McpAppViewApi {
  /** 按模型工具调用 id 准备 App 实例；历史恢复无本机结果时只返回文本回退。 */
  prepare(callId: string): Promise<McpAppViewDescriptor>
  /** 转发 App 的 JSON-RPC 小包；返回规范 JSON-RPC 2.0 信封（单层 result | error）。 */
  dispatch(instanceId: string, message: unknown): Promise<unknown>
  /** 释放一个实例；不影响其它实例 / 其它会话。 */
  release(instanceId: string): Promise<void>
  /**
   * 读取某次模型调用（callId）对应的、已落盘的 App 调用审计摘要。
   * 每次都核对当前前台 session 归属：不同会话的文件不读，仅凭 callId 不跨会话。
   */
  audit(callId: string): Promise<McpAppViewAuditEntry[]>
  /** 宿主代理工具快照的只读状态；只计当前项目可见条目，不泄其它项目。 */
  snapshot(): Promise<McpAppViewSnapshot>
  /** 显式刷新宿主代理工具快照（唯一会连接托管服务的入口；只连全局 + 本项目）。 */
  refresh(): Promise<McpAppViewRefreshResult>
  /**
   * 读取某个**已打开实例**当前的可信宿主上下文（与 `ui/initialize` 同一真源）。
   *
   * 只按 `instanceId` 反查宿主已登记的实例，再核对同一份 owner / 运行代次守卫；
   * 实例不存在、归属失效或解析失败都返回 `null`。它供渲染端在主题 / 外观变化后，
   * 经受控通道向该实例推 `ui/notifications/host-context-changed`；**不是**授权接口，
   * 不执行工具、不改实例状态，也不接受渲染端自报主题当身份。
   */
  hostContext(instanceId: string): Promise<unknown | null>
}

/** IPC 通道名；preload 与主进程共用，避免两处字符串漂移。 */
export const MCP_APP_VIEW_CHANNELS = {
  prepare: 'yan:mcpAppView:prepare',
  dispatch: 'yan:mcpAppView:dispatch',
  release: 'yan:mcpAppView:release',
  audit: 'yan:mcpAppView:audit',
  snapshot: 'yan:mcpAppView:snapshot',
  refresh: 'yan:mcpAppView:refresh',
  hostContext: 'yan:mcpAppView:hostContext'
} as const
