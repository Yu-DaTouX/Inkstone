/**
 * 托管 MCP 工具的**模型代理薄层**（设计 A2）。
 *
 * 由砚宿主在启动 pi 前写一份只读快照（`YAN_MCP_APP_TOOLS` 指向它），本扩展在
 * 工厂期同步读它，把当前允许模型看的托管工具注册成 `mcp__<server>__<tool>`。
 * 工具名、描述、参数 schema 与 annotations **逐字来自宿主**，所以：
 *
 *   · `danger-guard.js` 的 `^mcp__(.+?)__(.+)$` 命中不变，注解审批与托管前同口径；
 *   · 结果由 pi 代码网关注入容量上限，也不需要这里复制任何模型循环。
 *
 * 执行时**只**打回宿主能力端点（`127.0.0.1` + 每实例 Bearer token）的
 * `mcp.app.call`；端点不可用就直接失败，**不**回退直连、**不**降级成 `yan mcp call`。
 * 原始 `_meta` / `structuredContent` 留在宿主，回给模型的只有 content 文本。
 *
 * 失败一律封闭：快照缺失 / 解析失败 / 名字碰撞 / 缺字段 → 不注册（或整体不注册），
 * 并把原因写到 stderr，绝不静默注册一份半可信的工具表。
 */
import { readFileSync } from 'node:fs'

/** `-` → `_`，与宿主 `normalizeMcpAppToolName` 同形。 */
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
    /* 报告失败不能反过来影响 pi 启动 */
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

/**
 * 从快照构建要注册的工具定义。
 *
 * `projectId` 是当前 runner 的项目身份（宿主由能力端点绑定值注入，模型不能自报）：
 * 只注册「全局（无 `projectScope`）」+「当前项目」的工具，**别的项目的工具连
 * schema / 描述都不注册**，避免跨项目元数据泄露。项目范围工具缺项目身份时一律跳过。
 *
 * 任何一项非法（缺 serverId / toolName、名字规范化后碰撞）都让整份快照落空：
 * 服务端刷新时也会拒碰撞，这里是第二道，宁可全不注册也不静默覆盖。
 */
export function buildToolDefinitions(tools, projectId) {
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
          : `MCP 工具 ${serverId}/${toolName}（砚托管）`,
      parameters: safeSchema(entry.inputSchema),
      ...(annotations ? { annotations } : {}),
      execute: (toolCallId, params, signal) => callHost({ toolCallId, serverId, toolName, params, signal })
    })
  }
  return { definitions }
}

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
    /* 没有快照 = 没有缓存：明确待用户刷新，不默认连接任何服务器。 */
    report('没有工具快照（YAN_MCP_APP_TOOLS 未设置），未注册托管 MCP 工具；请在设置中刷新工具快照')
    return
  }
  /* runner 项目身份（宿主端点绑定值）：只注册全局 + 本项目的托管工具。 */
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
  for (const definition of built.definitions) {
    try {
      pi.registerTool(definition)
    } catch (error) {
      report(`注册 ${definition.name} 失败：${String(error?.message ?? error)}（可能已存在同名工具，已跳过）`)
    }
  }
}
