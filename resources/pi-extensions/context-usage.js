import { registerProviderRequestStage } from './provider-request.js'

export const CONTEXT_USAGE_STATUS_KEY = 'inkstone_context_usage'

const MEMORY_SECTIONS = new Set(['project_context'])
const SKILL_SECTIONS = new Set(['skills', 'inkstone_session_skills'])
const MCP_INFO_SECTIONS = new Set(['mcp_servers', 'inkstone_hosted_mcp'])
const SYSTEM_ROLES = new Set(['system', 'developer'])
const PLACEHOLDER_TOOLS = new Set(['__pi_deferred_placeholder__'])

export function estimateTextTokens(text) {
  if (!text) return 0
  let ascii = 0
  let other = 0
  for (let i = 0; i < text.length; i += 1) text.charCodeAt(i) < 128 ? (ascii += 1) : (other += 1)
  return Math.ceil(ascii / 4 + other)
}

function jsonTokens(value) {
  try {
    return estimateTextTokens(JSON.stringify(value) ?? '')
  } catch {
    return 0
  }
}

function blockText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && typeof block.text === 'string' && (block.type === undefined || /text$/.test(block.type)))
    .map((block) => block.text)
    .join('\n\n')
}

function messageList(payload) {
  if (Array.isArray(payload?.messages)) return payload.messages
  if (Array.isArray(payload?.input)) return payload.input
  return []
}

export function systemTextOf(payload) {
  const parts = []
  if (payload?.system !== undefined) parts.push(blockText(payload.system))
  if (typeof payload?.instructions === 'string') parts.push(payload.instructions)
  for (const message of messageList(payload)) {
    if (message && SYSTEM_ROLES.has(message.role)) parts.push(blockText(message.content))
  }
  return parts.filter(Boolean).join('\n\n')
}

function toolName(tool) {
  return String(tool?.name ?? tool?.function?.name ?? '')
}

export function sentToolsOf(payload) {
  const sent = []
  const deferred = []
  for (const tool of Array.isArray(payload?.tools) ? payload.tools : []) {
    const name = toolName(tool)
    if (!name || PLACEHOLDER_TOOLS.has(name)) continue
    if (tool.defer_loading === true) deferred.push(name)
    else sent.push({ name, tokens: jsonTokens(tool) })
  }
  for (const message of messageList(payload)) {
    if (message?.type === 'tool_search_output' && Array.isArray(message.tools)) {
      for (const tool of message.tools) {
        const name = toolName(tool)
        if (name) sent.push({ name, tokens: jsonTokens(tool) })
      }
    }
    if (!Array.isArray(message?.content)) continue
    for (const block of message.content) {
      const definition = block?.type === 'tool_addition' ? block.tool?.definition : undefined
      const name = toolName(definition)
      if (name) sent.push({ name, tokens: jsonTokens(definition) })
    }
  }
  return { sent, deferred }
}

export function splitSections(text) {
  const sections = []
  const head = /(^|\n)<([a-z][a-z0-9_]*)>\n/g
  let rest = 0
  let match
  while ((match = head.exec(text))) {
    const name = match[2]
    const start = match.index + match[1].length
    const close = `\n</${name}>`
    const end = text.indexOf(close, head.lastIndex)
    if (end < 0) continue
    if (start > rest) sections.push({ name: '', text: text.slice(rest, start) })
    const stop = end + close.length
    sections.push({ name, text: text.slice(start, stop) })
    rest = stop
    head.lastIndex = stop
  }
  if (rest < text.length) sections.push({ name: '', text: text.slice(rest) })
  return sections
}

function decodeXml(text) {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}

export function memoryFilesOf(text) {
  const files = []
  const pattern = /<project_instructions path="([^"]*)">\n[\s\S]*?\n<\/project_instructions>/g
  let match
  while ((match = pattern.exec(text))) files.push([match[1], estimateTextTokens(match[0])])
  return files
}

export function skillsOf(text) {
  const skills = []
  const pattern = /<skill>[\s\S]*?<\/skill>/g
  let match
  while ((match = pattern.exec(text))) {
    const name = /<name>([\s\S]*?)<\/name>/.exec(match[0])?.[1]
    if (name) skills.push([decodeXml(name.trim()), estimateTextTokens(match[0])])
  }
  return skills
}

export function mcpServersOf(text) {
  const servers = []
  const hosted = /Inkstone-hosted MCP servers: ([^\n]*?)\.(?=\s|$)/.exec(text)
  if (hosted) {
    const names = hosted[1].split(',').map((name) => name.trim()).filter(Boolean)
    const share = Math.ceil(estimateTextTokens(text) / Math.max(1, names.length))
    for (const name of names) servers.push([name, share])
    return servers
  }
  const pattern = /^- ([^\s(:]+)[^\n]*(?:\n(?!- |<\/)[^\n]*)*/gm
  let match
  while ((match = pattern.exec(text))) servers.push([match[1], estimateTextTokens(match[0])])
  return servers
}

function merged(rows) {
  const byName = new Map()
  for (const row of rows) {
    const hit = byName.get(row[0])
    if (!hit) byName.set(row[0], [...row])
    else {
      hit[1] += row[1]
      if (row.length > 2) hit[2] = Math.min(hit[2], row[2])
    }
  }
  return [...byName.values()]
}

function isMcpTool(tool) {
  return !!tool?.namespace || /^mcp__/i.test(String(tool?.name ?? ''))
}

export function contextUsageReport({ payload, systemPrompt = '', tools = [] }) {
  const text = systemTextOf(payload) || String(systemPrompt ?? '')
  const report = { v: 1, prompt: 0, builtin: 0, mcp: 0, skills: 0, mcpInfo: 0, memory: 0, deferred: { builtin: 0, mcp: 0 }, mcpTools: [], memoryFiles: [], skillList: [], builtinTools: [], mcpServers: [] }
  for (const section of splitSections(text)) {
    const tokens = estimateTextTokens(section.text)
    if (MEMORY_SECTIONS.has(section.name)) {
      report.memory += tokens
      report.memoryFiles.push(...memoryFilesOf(section.text))
    } else if (SKILL_SECTIONS.has(section.name)) {
      report.skills += tokens
      report.skillList.push(...skillsOf(section.text))
    } else if (MCP_INFO_SECTIONS.has(section.name)) {
      report.mcpInfo += tokens
      report.mcpServers.push(...mcpServersOf(section.text))
    } else report.prompt += tokens
  }
  const registered = new Map()
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (tool?.name && tool.exposure !== 'hidden') registered.set(String(tool.name).toLowerCase(), tool)
  }
  const { sent } = sentToolsOf(payload)
  const sentNames = new Set()
  for (const tool of sent) {
    const key = tool.name.toLowerCase()
    sentNames.add(key)
    const own = registered.get(key)
    const mcp = own ? isMcpTool(own) : /^mcp__/i.test(tool.name)
    if (mcp) {
      report.mcp += tool.tokens
      report.mcpTools.push([own?.name ?? tool.name, tool.tokens, 0])
    } else {
      report.builtin += tool.tokens
      report.builtinTools.push([own?.name ?? tool.name, tool.tokens, 0])
    }
  }
  for (const [key, tool] of registered) {
    if (sentNames.has(key)) continue
    const tokens = jsonTokens({ name: tool.name, description: tool.description ?? '', parameters: tool.parameters ?? {} })
    if (isMcpTool(tool)) {
      report.deferred.mcp += tokens
      report.mcpTools.push([tool.name, tokens, 1])
    } else {
      report.deferred.builtin += tokens
      report.builtinTools.push([tool.name, tokens, 1])
    }
  }
  report.mcpTools = merged(report.mcpTools).sort((a, b) => a[2] - b[2] || b[1] - a[1])
  report.memoryFiles = merged(report.memoryFiles).sort((a, b) => b[1] - a[1])
  report.skillList = merged(report.skillList).sort((a, b) => b[1] - a[1])
  report.builtinTools = merged(report.builtinTools).sort((a, b) => a[2] - b[2] || b[1] - a[1])
  report.mcpServers = merged(report.mcpServers).sort((a, b) => b[1] - a[1])
  return report
}

export function createContextUsage() {
  let last = null

  const onRequest = (payload, { ui, systemPrompt, tools }) => {
    if (!payload || typeof payload !== 'object') return
    try {
      const text = JSON.stringify(contextUsageReport({ payload, systemPrompt, tools }))
      if (text === last) return
      last = text
      ui?.setStatus?.(CONTEXT_USAGE_STATUS_KEY, text)
    } catch {
    }
  }

  const reset = () => {
    last = null
  }

  return { onRequest, reset }
}

export default function contextUsageExtension(pi) {
  const usage = createContextUsage()
  const read = (get, fallback) => {
    try {
      return get() ?? fallback
    } catch {
      return fallback
    }
  }
  registerProviderRequestStage(pi, 'context-usage', (payload, ctx) => {
    usage.onRequest(payload, {
      ui: read(() => ctx.ui, undefined),
      systemPrompt: read(() => ctx.getSystemPrompt(), ''),
      tools: read(() => pi.getAllTools(), [])
    })
  })
  for (const event of ['session_before_switch', 'session_before_fork', 'session_before_tree', 'session_shutdown']) {
    pi.on(event, () => usage.reset())
  }
}
