import { createHash } from 'node:crypto'
import { readFileSync, unwatchFile, watchFile } from 'node:fs'

const MAX_TOOL_NAME_LENGTH = 64

function toolNameFor(serverId, toolName) {
  const name = `mcp__${serverId}__${toolName}`.replace(/[^A-Za-z0-9_]/g, '_')
  if (name.length <= MAX_TOOL_NAME_LENGTH) return name
  const hash = createHash('sha256').update(`${serverId}\0${toolName}`).digest('hex').slice(0, 8)
  return `${name.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`
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

function parseSnapshot(text) {
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
  const candidates = []
  const groups = new Map()
  for (const entry of tools) {
    if (!entry || typeof entry !== 'object') return { error: '快照里混入了非对象工具项' }
    const serverId = typeof entry.serverId === 'string' ? entry.serverId.trim() : ''
    const toolName = typeof entry.toolName === 'string' ? entry.toolName.trim() : ''
    if (!serverId || !toolName) return { error: '工具项缺少 serverId 或 toolName' }
    const scope = typeof entry.projectScope === 'string' ? entry.projectScope.trim() : ''
    if (scope && scope !== projectId) continue
    const projectEnabled = projectId && Object.hasOwn(entry.projectEnabled ?? {}, projectId) ? entry.projectEnabled[projectId] : undefined
    if ((projectEnabled ?? entry.enabled) === false) continue
    const name = toolNameFor(serverId, toolName)
    const label = `${serverId}/${toolName}`
    candidates.push({ entry, serverId, toolName, name, label })
    groups.set(name, [...(groups.get(name) ?? []), label])
  }
  const collisions = [...groups.entries()].filter(([, labels]) => labels.length > 1).map(([name, labels]) => ({ name, labels }))
  const collided = new Set(collisions.map((collision) => collision.name))
  const definitions = []
  for (const { entry, serverId, toolName, name, label } of candidates) {
    if (collided.has(name)) continue
    const annotations = safeAnnotations(entry.annotations)
    definitions.push({
      name,
      label,
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
  return { definitions, collisions }
}

export function hostedServersNote(definitions) {
  const servers = [...new Set(definitions.map((definition) => definition.namespace?.name).filter(Boolean))].sort()
  if (servers.length === 0) return ''
  return `Inkstone-hosted MCP servers: ${servers.join(', ')}. Their tools are not declared to you upfront; load them with \`tool_search\` (the server name is a reliable query).`
}

const HOSTED_SERVERS_SECTION = 'inkstone_hosted_mcp'

async function callHost({ toolCallId, serverId, toolName, params, signal }) {
  const url = process.env.YAN_CLI_URL
  const token = process.env.YAN_CLI_TOKEN
  const sessionId = process.env.YAN_SESSION_ID
  const projectId = process.env.YAN_PROJECT_ID
  if (!url || !token || !sessionId || !projectId) {
    return errorResult('Hosted MCP channel unavailable: the Inkstone host endpoint is not ready. The call was not made.')
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
    return errorResult(cancelled ? 'Hosted MCP call cancelled.' : `Hosted MCP call failed: ${String(error?.message ?? error)}`)
  }
  let payload
  try {
    payload = await response.json()
  } catch {
    return errorResult('Hosted MCP channel returned a non-JSON response; the call was not made.')
  }
  if (!payload?.ok) {
    const detail = typeof payload?.error === 'string' ? payload.error : 'unknown error'
    const code = typeof payload?.code === 'string' ? ` (${payload.code})` : ''
    return errorResult(`Hosted MCP call not allowed: ${detail}${code}`)
  }
  const summary = payload.summary ?? {}
  const text = typeof summary.text === 'string' ? summary.text : ''
  if (summary.isError === true) return errorResult(text || 'Hosted MCP tool returned an error.')
  return { content: [{ type: 'text', text }], details: {} }
}

export default function mcpAppProxy(pi) {
  const file = process.env.YAN_MCP_APP_TOOLS
  if (!file) {
    report('没有工具快照（YAN_MCP_APP_TOOLS 未设置），未注册托管 MCP 工具；请在设置中刷新工具快照')
    return
  }
  const projectId = process.env.YAN_MCP_APP_PROJECT_ID || ''
  const registered = new Map()
  let previousText
  let note = ''
  function register(definition) {
    try {
      pi.registerTool(definition)
      return true
    } catch (error) {
      report(`注册 ${definition.name} 失败：${String(error?.message ?? error)}`)
      return false
    }
  }
  function syncTools() {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      return
    }
    if (text === previousText) return
    previousText = text
    const snapshot = parseSnapshot(text)
    const built = snapshot.error ? snapshot : buildToolDefinitions(snapshot.tools, projectId)
    if (built.error) {
      report(`工具快照不可用：${built.error}`)
      return
    }
    for (const collision of built.collisions) {
      report(`名字规范化后碰撞：${collision.name}（${collision.labels.join('、')}），这些工具未注册，其余托管工具不受影响`)
    }
    const nextNames = new Set(built.definitions.map((definition) => definition.name))
    const removed = new Set()
    for (const [name, { definition }] of registered) {
      if (nextNames.has(name)) continue
      if (register({ ...definition, exposure: 'hidden', execute: () => errorResult(`Hosted MCP tool ${definition.label} is no longer available.`) })) {
        registered.delete(name)
        removed.add(name)
      }
    }
    if (removed.size) {
      const active = pi.getActiveTools?.() ?? []
      if (active.some((name) => removed.has(name))) pi.setActiveTools(active.filter((name) => !removed.has(name)))
    }
    for (const definition of built.definitions) {
      const fingerprint = JSON.stringify(definition)
      if (registered.get(definition.name)?.fingerprint === fingerprint) continue
      if (register(definition)) registered.set(definition.name, { definition, fingerprint })
    }
    note = hostedServersNote([...registered.values()].map(({ definition }) => definition))
  }
  watchFile(file, { persistent: false, interval: 500 }, syncTools)
  pi.on('session_shutdown', () => unwatchFile(file, syncTools))
  pi.on('tool_call', (event) => {
    if (event.toolName === 'tool_search') syncTools()
  })
  syncTools()
  pi.on('before_agent_start', (event) => {
    syncTools()
    const base = String(event?.systemPrompt ?? '')
    const sections = event?.systemPromptOptions?.sections
    if (!note) {
      if (sections) delete sections[HOSTED_SERVERS_SECTION]
      return
    }
    if (base.includes(note)) return
    if (sections && typeof sections === 'object') {
      sections[HOSTED_SERVERS_SECTION] = note
      return
    }
    return { systemPrompt: base ? `${base}\n\n${note}` : note }
  })
}
