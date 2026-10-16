export type McpTransportKind = 'stdio' | 'http'

export interface McpServerConfig {
  id: string
  title?: string
  transport: McpTransportKind
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  authRef?: string
  projectScope?: string
  effect?: 'read' | 'write' | 'external-action' | 'unknown'
  enabled?: boolean
  migratedToNative?: McpMigratedToNativeMark
}

export interface McpMigratedToNativeMark {
  at: string
  targetPath: string
  nativeName?: string
}

export interface McpToolDescriptor {
  name: string
  description?: string
  inputSchema?: unknown
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } | null
}

export type McpServerStatus = 'ready' | 'connecting' | 'disconnected' | 'needs-auth' | 'error'

export function mcpToolCapabilityId(serverId: string, toolName: string): string {
  return `mcp:${serverId}/${toolName}`
}

export function parseMcpToolId(id: string): { serverId: string; toolName: string } | null {
  if (!id.startsWith('mcp:')) return null
  const rest = id.slice('mcp:'.length)
  const slash = rest.indexOf('/')
  if (slash <= 0 || slash === rest.length - 1) return null
  return { serverId: rest.slice(0, slash), toolName: rest.slice(slash + 1) }
}

export interface SchemaCheckResult {
  ok: boolean
  missing: string[]
  typeErrors: string[]
}

export function checkToolArguments(schema: unknown, args: Record<string, unknown>): SchemaCheckResult {
  if (!schema || typeof schema !== 'object') return { ok: true, missing: [], typeErrors: [] }
  const s = schema as { type?: unknown; required?: unknown; properties?: unknown }
  if (s.type && s.type !== 'object') return { ok: true, missing: [], typeErrors: [] }

  const required = Array.isArray(s.required) ? s.required.filter((k): k is string => typeof k === 'string') : []
  const missing = required.filter((key) => args[key] === undefined || args[key] === null)

  const typeErrors: string[] = []
  const properties =
    s.properties && typeof s.properties === 'object' ? (s.properties as Record<string, unknown>) : {}
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue
    const prop = properties[key]
    if (!prop || typeof prop !== 'object') continue
    const expected = (prop as { type?: unknown }).type
    if (typeof expected !== 'string') continue
    const actual = Array.isArray(value) ? 'array' : typeof value
    const wanted = expected === 'integer' ? 'number' : expected
    if (wanted === 'number' && actual === 'number') continue
    if (actual !== wanted) typeErrors.push(`${key}: 期望 ${expected}，实际 ${actual}`)
  }
  return { ok: missing.length === 0 && typeErrors.length === 0, missing, typeErrors }
}

export function schemaRevisionOf(schema: unknown): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical)
    if (value && typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      return Object.fromEntries(entries.map(([k, v]) => [k, canonical(v)]))
    }
    return value
  }
  const text = JSON.stringify(canonical(schema ?? null)) ?? 'null'
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function toolResultText(result: unknown): string {
  if (!result || typeof result !== 'object') return ''
  const content = (result as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    const c = item as { type?: unknown; text?: unknown; mimeType?: unknown; data?: unknown }
    if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text)
    else if (c.type === 'image') parts.push(`[图片 ${String(c.mimeType ?? '未知类型')}]`)
    else if (c.type === 'resource') parts.push('[资源]')
    else if (typeof c.type === 'string') parts.push(`[${c.type}]`)
  }
  return parts.join('\n')
}

export function classifyMcpResult(result: unknown): { toolError: boolean; text: string } {
  const isError = Boolean(result && typeof result === 'object' && (result as { isError?: unknown }).isError)
  return { toolError: isError, text: toolResultText(result) }
}
