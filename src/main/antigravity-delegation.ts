import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { AntigravityMcpServer } from './antigravity'
import type { CapabilityCommandResult } from './capability-server'
import { ANTIGRAVITY_PROVIDER } from '../shared/antigravity'
import { mcpApprovalNeeded } from '../shared/mcp-approval'
import { THINKING_LEVELS } from '../shared/thinking-levels'
import { runMcpCommand, type McpCommandHost } from './agent-commands/mcp-command'
import type { AntigravityMcpService } from './antigravity-mcp'
import { describeMcpTool, type McpCallOutcome } from './mcp/tool-service'
import { SCRIPT_GUIDE } from './browser/script-runner'

export type AntigravityBrowserCommand = (action: 'run' | 'screenshot', params: Record<string, unknown>, signal: AbortSignal) => Promise<CapabilityCommandResult>

const BROWSER_RESULT_CHARS = 30_000
const MAX_RELAYED_IMAGES = 4

function imageMime(file: string): string {
  const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase()
  return ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/png'
}

const BROWSER_TOOLS = [
  {
    name: 'browser_run',
    description: `Run a JavaScript snippet in Inkstone's built-in browser, the panel the user sees beside this chat (with the user's signed-in sites). Use it for any web page task: open pages, read them, fill forms, click. Do several steps in one call and return what you need to check. The user can take over the browser; then calls fail with USER_CONTROL_ACTIVE and you should wait. API (中文):\n\n${SCRIPT_GUIDE}`,
    inputSchema: { type: 'object' as const, properties: { code: { type: 'string', description: 'Async function body; may use await and return a JSON-serializable value.' } }, required: ['code'], additionalProperties: false }
  },
  {
    name: 'browser_screenshot',
    description: 'Screenshot the active tab of Inkstone\'s built-in browser and return the image. Use only when layout or visuals matter; prefer browser_run with page.snapshot() or page.text() for content.',
    inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false }
  }
]

interface DelegationTurn {
  signal: AbortSignal
  mode?: string
  run?(command: 'subagent.start' | 'subagent.get' | 'subagent.send' | 'subagent.set_model', params: Record<string, unknown>): Promise<CapabilityCommandResult>
}

function validPiModel(value: unknown): boolean {
  return typeof value === 'string' && !!value.trim() && value.length <= 200 && value.includes('/') && !value.trim().toLowerCase().startsWith(`${ANTIGRAVITY_PROVIDER}/`)
}

export async function openAntigravityDelegation(script: string, active: () => DelegationTurn | undefined,
  options: { delegate: boolean; browser?: AntigravityBrowserCommand; services: AntigravityMcpService[]; commandHost: McpCommandHost; owned?: Set<string> }) {
  const name = 'inkstone-pi'
  const secret = Buffer.from(`Bearer ${randomBytes(32).toString('hex')}`)
  const owned = options.owned ?? new Set<string>()
  const knownTools = new Set<string>([...(options.delegate ? ['start_pi_subagent', 'get_pi_subagent', 'send_pi_subagent', 'switch_pi_subagent_model'] : []), ...(options.browser ? BROWSER_TOOLS.map((tool) => tool.name) : [])])
  const ownRoute = options.delegate || !!options.browser
  let started = 0
  let starting = 0
  const createMcp = (service: AntigravityMcpService | undefined, requestSignal: AbortSignal) => {
    const mcp = new Server({ name: service?.name ?? name, version: '1.0.0' }, { capabilities: { tools: {} } })
    mcp.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = service
        ? (await service.manager.listToolsRaw(service.name, { signal: requestSignal })).filter((tool) => service.exposes?.(tool.name) !== false).flatMap((tool) => {
            const schema = tool.inputSchema as { type?: unknown } | undefined
            return schema?.type === 'object' ? [{ name: tool.name, description: tool.description, inputSchema: { ...schema, type: 'object' as const } }] : []
          })
        : [
        ...(options.browser ? BROWSER_TOOLS : []),
        ...(options.delegate ? [
        { name: 'start_pi_subagent', description: 'Delegate an independent coding task to an Inkstone Pi subagent in the current project. Provide a short `title` for the subagent card so parallel subagents stay distinct. Returns its id; use get_pi_subagent to read the result, send_pi_subagent to continue or resume with context, and switch_pi_subagent_model to change model/thinking.', inputSchema: { type: 'object', properties: { task: { type: 'string' }, title: { type: 'string', description: 'Short 2-8 word title displayed on the subagent card (distinct per subagent when running in parallel)' }, model: { type: 'string', description: 'Optional exact Pi provider/model' }, thinkingLevel: { type: 'string', enum: [...THINKING_LEVELS], description: 'Optional Pi thinking level (off, minimal, low, medium, high, xhigh, max)' }, readOnly: { type: 'boolean' } }, required: ['task', 'title'], additionalProperties: false } },
        { name: 'get_pi_subagent', description: 'Read the state and final answer of a Pi subagent started by this Antigravity session.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } },
        { name: 'send_pi_subagent', description: 'Send a follow-up or steering message to an existing Pi subagent started by this Antigravity session. If it has finished, stopped, or failed (e.g. rate-limited), it resumes with its full prior context preserved. Optionally pass model and/or thinkingLevel to switch models when continuing or resuming.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, message: { type: 'string', description: 'Follow-up instruction or continuation prompt for the subagent' }, mode: { type: 'string', enum: ['steer', 'follow-up'], description: 'Delivery mode while running (default: steer). Ignored when resuming a stopped/finished subagent.' }, model: { type: 'string', description: 'Optional exact Pi provider/model to switch to' }, thinkingLevel: { type: 'string', enum: [...THINKING_LEVELS], description: 'Optional Pi thinking level (off, minimal, low, medium, high, xhigh, max)' } }, required: ['id', 'message'], additionalProperties: false } },
        { name: 'switch_pi_subagent_model', description: 'Switch the Pi model and/or thinking level of an existing Pi subagent started by this Antigravity session. Applies immediately while running, or updates the model used on the next resume via send_pi_subagent.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, model: { type: 'string', description: 'Optional exact Pi provider/model' }, thinkingLevel: { type: 'string', enum: [...THINKING_LEVELS], description: 'Optional Pi thinking level (off, minimal, low, medium, high, xhigh, max)' } }, required: ['id'], additionalProperties: false } },
        ] : []),
      ]
      for (const tool of tools) knownTools.add(tool.name)
      return { tools }
    })
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
          const response = await runMcpCommand(
            { ...options.commandHost, mcpConnectionManager: () => service.manager, permissionMode: async () => (turn.mode === 'auto' ? 'all' : 'danger') },
            'call', { serverId: service.name, toolName: params.name, arguments: args }, signal)
          const data = response.data as McpCallOutcome
          const images = await Promise.all((data.images ?? []).slice(0, MAX_RELAYED_IMAGES).map(async (file) => {
            try { return { type: 'image' as const, data: (await readFile(file)).toString('base64'), mimeType: imageMime(file) } } catch { return null }
          }))
          return { content: [{ type: 'text' as const, text: data.text }, ...images.filter((image) => image !== null)], ...(data.toolError ? { isError: true } : {}) }
        }
        if (options.browser && (params.name === 'browser_run' || params.name === 'browser_screenshot')) {
          const signal = AbortSignal.any([turn.signal, requestSignal])
          if (params.name === 'browser_screenshot') {
            const { summary } = await options.browser('screenshot', {}, signal)
            const path = typeof summary.savedTo === 'string' ? summary.savedTo : ''
            const mimeType = typeof summary.mimeType === 'string' ? summary.mimeType : 'image/png'
            if (!path) return result({ error: 'Screenshot was not saved.' }, true)
            return { content: [{ type: 'image' as const, data: (await readFile(path)).toString('base64'), mimeType }] }
          }
          if (turn.mode === 'plan') return result({ error: 'Plan mode does not permit browser actions; use browser_screenshot to look.' }, true)
          if (typeof args.code !== 'string' || !args.code.trim()) return result({ error: 'browser_run needs code.' }, true)
          const { summary, data } = await options.browser('run', { code: args.code }, signal)
          const out = (data ?? {}) as { result?: unknown; logs?: string[]; url?: string; title?: string; runtime?: string }
          const full = out.result === undefined || out.result === null ? undefined : typeof out.result === 'string' ? out.result : JSON.stringify(out.result)
          return result({
            url: out.url ?? summary.url,
            title: out.title ?? summary.title,
            ...(out.runtime ? { runtime: out.runtime } : {}),
            ...(full !== undefined ? { result: full.length > BROWSER_RESULT_CHARS ? `${full.slice(0, BROWSER_RESULT_CHARS)}…` : full } : {}),
            ...(out.logs?.length ? { logs: out.logs.slice(-50) } : {})
          })
        }
        if (!options.delegate) return result({ error: 'Unknown tool.' }, true)
        if (!turn.run) return result({ error: 'The Pi subagent bridge is unavailable.' }, true)
        if (params.name === 'start_pi_subagent') {
          if (turn.mode === 'plan' && args.readOnly !== true) return result({ error: 'Plan mode only permits read-only Pi subagents (set readOnly: true).' }, true)
          const title = typeof args.title === 'string' ? args.title.replace(/\s+/g, ' ').trim() : undefined
          if (args.title !== undefined && (typeof args.title !== 'string' || args.title.length > 200)) {
            return result({ error: 'Invalid Pi subagent title.' }, true)
          }
          const thinkingLevel = typeof args.thinkingLevel === 'string' ? args.thinkingLevel.trim().toLowerCase() : undefined
          if (args.thinkingLevel !== undefined && (!thinkingLevel || !THINKING_LEVELS.includes(thinkingLevel))) {
            return result({ error: `Invalid thinkingLevel. Allowed values: ${THINKING_LEVELS.join(', ')}.` }, true)
          }
          if (started + starting >= 32 || typeof args.task !== 'string' || !args.task.trim() || args.task.length > 16_000 || (args.readOnly !== undefined && typeof args.readOnly !== 'boolean') ||
            (args.model !== undefined && !validPiModel(args.model))) return result({ error: 'Invalid Pi subagent task or session limit reached.' }, true)
          starting += 1
          try {
            const { summary } = await turn.run('subagent.start', {
              task: args.task,
              ...(title ? { title } : {}),
              model: args.model,
              ...(thinkingLevel ? { thinkingLevel } : {}),
              readOnly: args.readOnly
            })
            if (typeof summary.id === 'string') {
              owned.add(summary.id)
              started += 1
            }
            return result(summary)
          } finally { starting -= 1 }
        }
        if (params.name === 'get_pi_subagent' && typeof args.id === 'string' && owned.has(args.id)) {
          const { summary, data } = await turn.run('subagent.get', { id: args.id })
          const run = data as { finalMessage?: string; model?: string; thinkingLevel?: string; error?: string; changedFiles?: string[]; brief?: { title?: string } } | undefined
          return result({
            id: args.id,
            status: summary.status,
            ...(run?.brief?.title ? { title: run.brief.title } : {}),
            model: run?.model,
            ...(run?.thinkingLevel ? { thinkingLevel: run.thinkingLevel } : {}),
            ...(typeof summary.latestActivity === 'string' && summary.latestActivity ? { latestActivity: summary.latestActivity } : {}),
            ...(Array.isArray(run?.changedFiles) && run.changedFiles.length ? { changedFiles: run.changedFiles } : {}),
            finalMessage: run?.finalMessage,
            error: run?.error
          })
        }
        if (params.name === 'send_pi_subagent' && typeof args.id === 'string' && owned.has(args.id)) {
          if (typeof args.message !== 'string' || !args.message.trim() || args.message.length > 16_000) {
            return result({ error: 'Invalid Pi subagent message.' }, true)
          }
          const rawMode = typeof args.mode === 'string' ? args.mode.trim().toLowerCase() : undefined
          if (args.mode !== undefined && rawMode !== 'steer' && rawMode !== 'follow-up') {
            return result({ error: 'Invalid mode. Allowed values: steer, follow-up.' }, true)
          }
          if (args.model !== undefined && !validPiModel(args.model)) {
            return result({ error: 'Invalid Pi subagent model.' }, true)
          }
          const thinkingLevel = typeof args.thinkingLevel === 'string' ? args.thinkingLevel.trim().toLowerCase() : undefined
          if (args.thinkingLevel !== undefined && (!thinkingLevel || !THINKING_LEVELS.includes(thinkingLevel))) {
            return result({ error: `Invalid thinkingLevel. Allowed values: ${THINKING_LEVELS.join(', ')}.` }, true)
          }
          if (turn.mode === 'plan') {
            const current = await turn.run('subagent.get', { id: args.id })
            const isolation = (current.data as { isolation?: unknown } | undefined)?.isolation
            if (isolation !== 'controlled-cwd') {
              return result({ error: 'Plan mode only permits continuing read-only Pi subagents.' }, true)
            }
          }
          const { summary } = await turn.run('subagent.send', {
            id: args.id,
            message: args.message,
            ...(rawMode ? { mode: rawMode } : {}),
            ...(typeof args.model === 'string' ? { model: args.model.trim() } : {}),
            ...(thinkingLevel ? { thinkingLevel } : {})
          })
          return result(summary)
        }
        if (params.name === 'switch_pi_subagent_model' && typeof args.id === 'string' && owned.has(args.id)) {
          if (args.model !== undefined && !validPiModel(args.model)) {
            return result({ error: 'Invalid Pi subagent model.' }, true)
          }
          const thinkingLevel = typeof args.thinkingLevel === 'string' ? args.thinkingLevel.trim().toLowerCase() : undefined
          if (args.thinkingLevel !== undefined && (!thinkingLevel || !THINKING_LEVELS.includes(thinkingLevel))) {
            return result({ error: `Invalid thinkingLevel. Allowed values: ${THINKING_LEVELS.join(', ')}.` }, true)
          }
          if (args.model === undefined && thinkingLevel === undefined) {
            return result({ error: 'Provide model or thinkingLevel to switch.' }, true)
          }
          const { summary } = await turn.run('subagent.set_model', {
            id: args.id,
            ...(typeof args.model === 'string' ? { model: args.model.trim() } : {}),
            ...(thinkingLevel ? { thinkingLevel } : {})
          })
          return result(summary)
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
    if (req.headers.host !== host || req.headers.origin || (!service && !(ownRoute && req.url === '/mcp')) || auth.length !== secret.length || !timingSafeEqual(auth, secret)) {
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
  const httpConfig = (serverName: string, path: string): AntigravityMcpServer => ({
    type: 'http', name: serverName, url: `http://${host}${path}`, headers: [{ name: 'Authorization', value: secret.toString() }]
  })
  return {
    httpConfigs: [...(ownRoute ? [httpConfig(name, '/mcp')] : []), ...options.services.map((service) => httpConfig(service.name, `/mcp/${service.name}`))],
    configs: [...(ownRoute ? [config(name, '/mcp')] : []), ...options.services.map((service) => config(service.name, `/mcp/${service.name}`))],
    knownTools: () => knownTools as ReadonlySet<string>,
    close: async () => {
      server.close()
      server.closeAllConnections()
    }
  }
}
