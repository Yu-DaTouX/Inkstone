/**
 * MCP 契约（实施-04 §4 / §5）—— 纯逻辑，无 IO。
 *
 * 为什么把「连接」与「契约」分开：连接（stdio / HTTP）依赖进程与网络，
 * 只能靠 live 场景验；而 **ID 规则、参数校验、结果转换、错误分类**是纯函数，
 * 可以用单测钉死。04-S3 最贵的失败不是「连不上」，而是「连上了却把两家服务的
 * 同名工具合并成一个」「服务自报只读就真的当只读」—— 那些都得靠这里的规则挡住。
 */

/** 传输方式。HTTP 在 §5 里是独立一片，契约先固定。 */
export type McpTransportKind = 'stdio' | 'http'

/**
 * 受信配置里的一条 MCP 服务。
 *
 * ⚠️ `effect` 由**配置**给出，不由服务自报 —— MCP 的 `readOnlyHint` 是
 * 「服务自己的说法」，不能当安全边界（实施-04 §4）。
 */
export interface McpServerConfig {
  id: string
  title?: string
  transport: McpTransportKind
  /** stdio：可执行文件与参数。 */
  command?: string
  args?: string[]
  env?: Record<string, string>
  /** http：端点地址。 */
  url?: string
  /** 需要认证时只记**引用名**；凭证本身不进配置文件。 */
  authRef?: string
  /** 项目私有服务的隔离键（§4：不同项目默认不可发现对方）。 */
  projectScope?: string
  /** 配置声明的副作用等级；缺省是 `unknown`（最保守）。 */
  effect?: 'read' | 'write' | 'external-action' | 'unknown'
  enabled?: boolean
}

/** 服务侧报回的工具描述（`tools/list` 的单项）。 */
export interface McpToolDescriptor {
  name: string
  description?: string
  inputSchema?: unknown
  /** 服务**自报**的提示；只用于展示，不参与权限判定。 */
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } | null
}

export type McpServerStatus = 'ready' | 'connecting' | 'disconnected' | 'needs-auth' | 'error'

/** 稳定 ID：**必须**带 serverId —— 两家服务的同名工具不能被合并（§4）。 */
export function mcpToolCapabilityId(serverId: string, toolName: string): string {
  return `mcp:${serverId}/${toolName}`
}

/** 从稳定 ID 反解（`mcp:<server>/<tool>`，工具名里允许 `/`）。 */
export function parseMcpToolId(id: string): { serverId: string; toolName: string } | null {
  if (!id.startsWith('mcp:')) return null
  const rest = id.slice('mcp:'.length)
  const slash = rest.indexOf('/')
  if (slash <= 0 || slash === rest.length - 1) return null
  return { serverId: rest.slice(0, slash), toolName: rest.slice(slash + 1) }
}

export interface SchemaCheckResult {
  ok: boolean
  /** 缺失的必填字段。 */
  missing: string[]
  /** 类型不符的字段（`字段: 期望`）。 */
  typeErrors: string[]
}

/**
 * 按 JSON Schema 的**最小子集**校验参数：`required` 与顶层 `type`。
 *
 * 为什么只做子集：完整的 JSON Schema 校验需要一个校验器依赖，而我们要挡的
 * 只有两类真实错误 —— 漏了必填字段、把字符串传成数字。剩下的交给服务自己。
 * **不**在这里做默认值填充：那会让「模型没给参数」变成我们替它瞎猜。
 */
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
    /* JSON Schema 的 integer 在 JS 里就是 number。 */
    const wanted = expected === 'integer' ? 'number' : expected
    if (wanted === 'number' && actual === 'number') continue
    if (actual !== wanted) typeErrors.push(`${key}: 期望 ${expected}，实际 ${actual}`)
  }
  return { ok: missing.length === 0 && typeErrors.length === 0, missing, typeErrors }
}

/**
 * schema 的稳定指纹：用于 `schemaRevision`。
 *
 * 键序不影响结果（排序后再哈希），否则服务端换个字段顺序就会被误判成
 * 「schema 变了」，进而把一次本来能成功的调用拒成 `schema-changed`。
 */
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
  /* 一个短而稳定的指纹就够：它只用来比对「是不是同一版」。 */
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** 工具结果的文本表示（供摘要与模型阅读）。 */
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

/**
 * 错误分类：**工具级错误**与**协议错误**必须分开（§5 / §13.1）。
 *
 * 依据是 MCP 的约定：工具自己失败时返回 `isError: true` 的**正常响应**，
 * 协议层失败才是抛异常。混在一起，模型就无法判断「该改参数重试」还是
 * 「这个服务坏了，别试了」。
 */
export function classifyMcpResult(result: unknown): { toolError: boolean; text: string } {
  const isError = Boolean(result && typeof result === 'object' && (result as { isError?: unknown }).isError)
  return { toolError: isError, text: toolResultText(result) }
}

/** 可用性投影：配置禁用 → disabled；其余由连接状态决定。 */
export function availabilityOfStatus(status: McpServerStatus): 'ready' | 'connecting' | 'disconnected' | 'needs-auth' | 'error' {
  return status
}
