/**
 * MCP 工具注解审批判定（宿主与薄扩展共用口径）。
 *
 * 模型发起与 App 视图发起必须走同一条判定：注解只决定「要不要询问」，不构成授权；
 * 缺注解按最严处理（要询问），显式破坏优先于只读。
 *
 * 这份 TS 是唯一口径来源，`resources/pi-extensions/danger-guard.js` 里的 JS 副本
 * 保留不改（扩展在 pi 子进程内运行，不能导入宿主模块）；两处输出由
 * `scripts/test-mcp-approval-parity.mjs` 用固定注解表逐条比对，防止漂移。
 * 同时使用 `idempotentHint` 的注解表是为了确认两处都**忽略**它。
 */

/** 服务自报的工具注解子集；非布尔值一律忽略，缺失等同于「未知」。 */
export interface McpToolAnnotations {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

/**
 * 服务自报注解只决定是否询问；缺注解默认询问，显式破坏优先于只读。
 * 与 `danger-guard.js` 的 `mcpApprovalNeeded` 逐字同口径。
 */
export function mcpApprovalNeeded(annotations: unknown): boolean {
  const hints = annotations && typeof annotations === 'object' ? (annotations as McpToolAnnotations) : {}
  if (hints.destructiveHint === true) return true
  if (hints.readOnlyHint === true) return false
  const mayDestroy = hints.destructiveHint ?? true
  const mayReachOutside = hints.openWorldHint ?? true
  return mayDestroy || mayReachOutside
}

/** `mcp__<服务>__<工具>` → 展示用的服务与工具名 */
export function mcpTarget(toolName: unknown): { server: string; tool: string } {
  const match = /^mcp__(.+?)__(.+)$/.exec(String(toolName ?? ''))
  return { server: match?.[1] ?? '', tool: match?.[2] ?? String(toolName ?? '') }
}

/** 这次调用要不要问；返回原因数组（空 = 不问）。非 `mcp__` 工具一律不问。 */
export function mcpCallDanger(toolName: unknown, annotations: unknown): string[] {
  const name = String(toolName ?? '')
  if (!name.startsWith('mcp__')) return []
  if (!mcpApprovalNeeded(annotations)) return []
  const { server, tool } = mcpTarget(name)
  const target = [server, tool].filter(Boolean).join(' / ')
  return [`MCP 工具可能修改数据或对外操作：${target}`]
}

/**
 * 叠上权限档位后的调用理由。
 *
 * `all` 档不额外拦截（返回空），`danger`（缺省 / 脏值）按注解询问；与薄扩展
 * `danger-guard.js` 的 `tool_call` 处理器早返回顺序一致。`all` 档仍「记录」的
 * 部分由调用方负责（此处只表达「不拦截」）。
 */
export function mcpCallReasons(toolName: unknown, annotations: unknown, permissionMode: unknown): string[] {
  if (permissionMode === 'all') return []
  return mcpCallDanger(toolName, annotations)
}
