export interface McpToolAnnotations {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

export function mcpApprovalNeeded(annotations: unknown): boolean {
  const hints = annotations && typeof annotations === 'object' ? (annotations as McpToolAnnotations) : {}
  if (hints.destructiveHint === true) return true
  if (hints.readOnlyHint === true) return false
  const mayDestroy = hints.destructiveHint ?? true
  const mayReachOutside = hints.openWorldHint ?? true
  return mayDestroy || mayReachOutside
}

export function mcpTarget(toolName: unknown): { server: string; tool: string } {
  const match = /^mcp__(.+?)__(.+)$/.exec(String(toolName ?? ''))
  return { server: match?.[1] ?? '', tool: match?.[2] ?? String(toolName ?? '') }
}

export function mcpCallDanger(toolName: unknown, annotations: unknown): string[] {
  const name = String(toolName ?? '')
  if (!name.startsWith('mcp__')) return []
  if (!mcpApprovalNeeded(annotations)) return []
  const { server, tool } = mcpTarget(name)
  const target = [server, tool].filter(Boolean).join(' / ')
  return [`MCP 工具可能修改数据或对外操作：${target}`]
}
