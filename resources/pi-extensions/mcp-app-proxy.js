import { readFileSync } from 'node:fs'

function normalizeSegment(value) {
  return String(value).replace(/-/g, '_')
}

function toolNameFor(serverId, toolName) {
  return `mcp__${normalizeSegment(serverId)}__${normalizeSegment(toolName)}`
}

function report(message) {
  try {
    process.stderr.write(`[mcp-app-proxy] ${message}\n`)
  } catch {
  }
}

function errorResult(text) {
  return { content: [{ type: 'text', text }], details: {}, isError: true }
}

function readSnapshot(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    return { error: `快照读取失败（${String(error?.message ?? error)}）` }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { error: `快照不是合法 JSON（${String(error?.message ?? error)}）` }
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.tools)) {
    return { error: '快照形状不对：缺少 tools 数组' }
  }
  return { tools: parsed.tools }
}

function safeSchema(schema) {
  if (schema && typeof schema === 'object' && !Array.isArray(schema) && typeof schema.type === 'string') return schema
  if (schema && typeof schema === 'object' && !Array.isArray(schema)) return { ...schema, type: schema.type ?? 'object' }
  return { type: 'object', properties: {} }
}

function safeAnnotations(annotations) {
  if (!annotations || typeof annotations !== 'object' || Array.isArray(annotations)) return undefined
  const copy = { ...annotations }
  return Object.keys(copy).length > 0 ? copy : undefined
}

function buildToolDefinitions(tools, projectId) {
  const definitions = []
  const names = new Map()
  for (const entry of tools) {
    if (!entry || typeof entry !== 'object') return { error: '快照里混入了非对象工具项' }
    const serverId = typeof entry.serverId === 'string' ? entry.serverId.trim() : ''
    const toolName = typeof entry.toolName === 'string' ? entry.toolName.trim() : ''
    if (!serverId || !toolName) return { error: '工具项缺少 serverId 或 toolName' }
    const scope = typeof entry.projectScope === 'string' ? entry.projectScope.trim() : ''
    if (scope && scope !== projectId) continue
    const name = toolNameFor(serverId, toolName)
    if (names.has(name)) {
      return { error: `名字规范化后碰撞：${name}（${names.get(name)} 与 ${serverId}/${toolName}），整份快照拒绝` }
    }
    names.set(name, `${serverId}/${toolName}`)
    const annotations = safeAnnotations(entry.annotations)
    definitions.push({
      name,
      label: `${serverId}/${toolName}`,
      description:
        typeof entry.description === 'string' && entry.description.trim()
          ? entry.description
          : `MCP tool ${toolName} on the Inkstone-hosted server ${serverId}`,
      parameters: safeSchema(entry.inputSchema),
      exposure: 'deferred',
      namespace: { name: serverId, description: `Inkstone-hosted MCP server ${serverId}` },
      ...(annotations ? { annotations } : {}),
      execute: (toolCallId, params, signal) => callHost({ toolCallId, serverId, toolName, params, signal })
    })
  }
  return { definitions }
}

export function hostedServersNote(definitions) {
  const servers = [...new Set(definitions.map((definition) => definition.namespace?.name).filter(Boolean))].sort()
  if (servers.length === 0) return ''
  return `Inkstone-hosted MCP servers: ${servers.join(', ')}. Their tools are not declared to you upfront; load them with \`tool_search\` or call them from codemode scripts.`
}

const HOSTED_SERVERS_SECTION = 'inkstone_hosted_mcp'

async function callHost({ toolCallId, serverId, toolName, params, signal }) {
  const url = process.env.YAN_CLI_URL
  const token = process.env.YAN_CLI_TOKEN
  const sessionId = process.env.YAN_SESSION_ID
  const projectId = process.env.YAN_PROJECT_ID
  if (!url || !token || !sessionId || !projectId) {
    return errorResult('托管 MCP 通道不可用：宿主能力端点未就绪（不降级为直连，也不走旧 yan 入口）')
  }
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        apiVersion: 1,
        command: 'mcp.app.call',
        params: { callId: toolCallId, serverId, toolName, arguments: params ?? {} },
        sessionId,
        projectId
      }),
      signal
    })
  } catch (error) {
    const cancelled = signal?.aborted === true || error?.name === 'AbortError'
    return errorResult(cancelled ? '托管 MCP 调用已取消（宿主已向后端转发取消）' : `托管 MCP 调用失败：${String(error?.message ?? error)}`)
  }
  let payload
  try {
    payload = await response.json()
  } catch {
    return errorResult('托管 MCP 通道返回了非 JSON 响应；未执行')
  }
  if (!payload?.ok) {
    const detail = typeof payload?.error === 'string' ? payload.error : '未知错误'
    const code = typeof payload?.code === 'string' ? `（${payload.code}）` : ''
    return errorResult(`托管 MCP 调用未获放行：${detail}${code}`)
  }
  const summary = payload.summary ?? {}
  const text = typeof summary.text === 'string' ? summary.text : ''
  if (summary.isError === true) return errorResult(text || '托管 MCP 工具返回错误')
  return { content: [{ type: 'text', text }], details: {} }
}

export default function mcpAppProxy(pi) {
  const file = process.env.YAN_MCP_APP_TOOLS
  if (!file) {
    report('没有工具快照（YAN_MCP_APP_TOOLS 未设置），未注册托管 MCP 工具；请在设置中刷新工具快照')
    return
  }
  const projectId = process.env.YAN_MCP_APP_PROJECT_ID || ''
  const snapshot = readSnapshot(file)
  if (snapshot.error) {
    report(`工具快照不可用，未注册任何托管 MCP 工具：${snapshot.error}`)
    return
  }
  if (snapshot.tools.length === 0) {
    report('工具快照为空；托管 MCP 工具未注册（请刷新或确认服务已连接）')
    return
  }
  const built = buildToolDefinitions(snapshot.tools, projectId)
  if (built.error) {
    report(`工具快照被拒绝，未注册任何托管 MCP 工具：${built.error}`)
    return
  }
  const registered = []
  for (const definition of built.definitions) {
    try {
      pi.registerTool(definition)
      registered.push(definition)
    } catch (error) {
      report(`注册 ${definition.name} 失败：${String(error?.message ?? error)}（可能已存在同名工具，已跳过）`)
    }
  }
  const note = hostedServersNote(registered)
  if (!note) return
  pi.on('before_agent_start', (event) => {
    const base = String(event?.systemPrompt ?? '')
    if (base.includes(note)) return
    const sections = event?.systemPromptOptions?.sections
    if (sections && typeof sections === 'object') {
      sections[HOSTED_SERVERS_SECTION] = note
      return
    }
    return { systemPrompt: base ? `${base}\n\n${note}` : note }
  })
}
