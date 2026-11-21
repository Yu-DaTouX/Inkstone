import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { AntigravityMcpServer } from './antigravity'
import type { CapabilityCommandResult } from './capability-server'
import { ANTIGRAVITY_PROVIDER } from '../shared/antigravity'
import { mcpApprovalNeeded } from '../shared/mcp-approval'
import { runMcpCommand, type McpCommandHost } from './agent-commands/mcp-command'
import type { AntigravityMcpService } from './antigravity-mcp'
import { describeMcpTool, type McpCallOutcome } from './mcp/tool-service'

interface DelegationTurn {
  signal: AbortSignal
  mode?: string
  run?(command: 'subagent.start' | 'subagent.get', params: Record<string, unknown>): Promise<CapabilityCommandResult>
}

export async function openAntigravityDelegation(script: string, active: () => DelegationTurn | undefined,
  options: { delegate: boolean; services: AntigravityMcpService[]; commandHost: McpCommandHost }) {
  const name = 'inkstone-pi'
  const secret = Buffer.from(`Bearer ${randomBytes(32).toString('hex')}`)
  const owned = new Set<string>()
  let starting = 0
  const createMcp = (service: AntigravityMcpService | undefined, requestSignal: AbortSignal) => {
    const mcp = new Server({ name: service?.name ?? name, version: '1.0.0' }, { capabilities: { tools: {} } })
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: service
      ? (await service.manager.listToolsRaw(service.name, { signal: requestSignal })).filter((tool) => service.exposes?.(tool.name) !== false).flatMap((tool) => {
          const schema = tool.inputSchema as { type?: unknown } | undefined
          return schema?.type === 'object' ? [{ name: tool.name, description: tool.description, inputSchema: { ...schema, type: 'object' as const } }] : []
        })
      : [
      { name: 'start_pi_subagent', description: 'Delegate an independent coding task to an Inkstone Pi subagent in the current project. Returns its id; use get_pi_subagent to read the result.', inputSchema: { type: 'object', properties: { task: { type: 'string' }, model: { type: 'string', description: 'Optional exact Pi provider/model' }, readOnly: { type: 'boolean' } }, required: ['task'], additionalProperties: false } },
      { name: 'get_pi_subagent', description: 'Read the state and final answer of a Pi subagent started by this Antigravity session.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } },
    ] }))
    mcp.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      const result = (value: unknown, isError = false) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) })
      const turn = active()
      if (!turn || turn.signal.aborted) return result({ error: 'No active Antigravity turn for this session.' }, true)
      const args = params.arguments ?? {}
      try {
        if (service) {
          if (service.exposes?.(params.name) === false) return result({ error: 'This MCP tool is hidden.' }, true)
          const signal = AbortSignal.any([turn.signal, requestSignal])
          if (turn.mode === 'plan') {
            const described = await describeMcpTool(service.manager, service.name, params.name, signal)
            if (mcpApprovalNeeded(described.annotations)) return result({ error: 'Plan mode only permits read-only MCP tools.' }, true)
          }
          const response = await runMcpCommand({ ...options.commandHost, mcpConnectionManager: () => service.manager, permissionMode: async () => 'danger' },
            'call', { serverId: service.name, toolName: params.name, arguments: args }, signal)
          const data = response.data as McpCallOutcome
          return { content: [{ type: 'text' as const, text: data.text }], ...(data.toolError ? { isError: true } : {}) }
        }
        if (!turn.run) return result({ error: 'The Pi subagent bridge is unavailable.' }, true)
        if (params.name === 'start_pi_subagent') {
          if (turn.mode === 'plan' && args.readOnly !== true) return result({ error: 'Plan mode only permits read-only Pi subagents (set readOnly: true).' }, true)
          if (owned.size + starting >= 32 || typeof args.task !== 'string' || !args.task.trim() || args.task.length > 16_000 || (args.readOnly !== undefined && typeof args.readOnly !== 'boolean') ||
            (args.model !== undefined && (typeof args.model !== 'string' || !args.model.trim() || args.model.length > 200 || !args.model.includes('/') || args.model.trim().toLowerCase().startsWith(`${ANTIGRAVITY_PROVIDER}/`)))) return result({ error: 'Invalid Pi subagent task or session limit reached.' }, true)
          starting += 1
          try {
            const { summary } = await turn.run('subagent.start', { task: args.task, model: args.model, readOnly: args.readOnly })
            if (typeof summary.id === 'string') owned.add(summary.id)
            return result(summary)
          } finally { starting -= 1 }
        }
        if (params.name === 'get_pi_subagent' && typeof args.id === 'string' && owned.has(args.id)) {
          const { summary, data } = await turn.run('subagent.get', { id: args.id })
          const run = data as { finalMessage?: string; model?: string; error?: string } | undefined
          return result({ id: args.id, status: summary.status, model: run?.model, finalMessage: run?.finalMessage, error: run?.error })
        }
        return result({ error: 'Unknown tool or subagent not owned by this connection.' }, true)
      } catch (error) {
        return result({ error: error instanceof Error ? error.message : String(error) }, true)
      }
    })
    return mcp
  }
  const routes = new Map(options.services.map((service) => [`/mcp/${service.name}`, service]))
  let host = ''
  const server = createServer((req, res) => {
    const auth = Buffer.from(req.headers.authorization ?? '')
    const service = routes.get(req.url ?? '')
    if (req.headers.host !== host || req.headers.origin || (!service && !(options.delegate && req.url === '/mcp')) || auth.length !== secret.length || !timingSafeEqual(auth, secret)) {
      res.writeHead(403).end()
      return
    }
    const lifetime = new AbortController()
    const mcp = createMcp(service, lifetime.signal)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.once('close', () => { lifetime.abort(); void mcp.close().catch(() => undefined) })
    void mcp.connect(transport).then(() => transport.handleRequest(req, res)).catch(() => {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  server.requestTimeout = 30_000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const addr = server.address()
  if (!addr || typeof addr === 'string') {
    server.close()
    throw new Error('Cannot bind the Inkstone Pi subagent bridge')
  }
  host = `127.0.0.1:${addr.port}`
  const config = (serverName: string, path: string): AntigravityMcpServer => ({
    name: serverName, command: process.execPath, args: [script], env: [
      { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
      { name: 'INKSTONE_PI_MCP_URL', value: `http://${host}${path}` },
      { name: 'INKSTONE_PI_MCP_AUTH', value: secret.toString() },
    ],
  })
  return {
    configs: [...(options.delegate ? [config(name, '/mcp')] : []), ...options.services.map((service) => config(service.name, `/mcp/${service.name}`))],
    close: async () => {
      server.close()
      server.closeAllConnections()
    }
  }
}
