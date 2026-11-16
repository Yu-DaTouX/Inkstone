import { appendFileSync } from 'node:fs'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const MARKER = process.env.WINDOWS_MCP_FIXTURE_LOG ?? ''
const FAIL_RELEASE = process.env.WINDOWS_MCP_FIXTURE_FAIL_RELEASE === '1'
const HANG_RELEASE = process.env.WINDOWS_MCP_FIXTURE_HANG_RELEASE === '1'
const TOOLS = ['Snapshot', 'Screenshot', 'Wait', 'Click', 'Type', 'App', 'ControlStatus']

const server = new Server({ name: 'windows-mcp-control-fixture', version: '1.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((name) => ({ name, inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: ['Snapshot', 'Screenshot', 'Wait'].includes(name) } }))
}))
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = String(request.params?.name ?? '')
  const args = request.params?.arguments ?? {}
  if (MARKER) appendFileSync(MARKER, `${name} ${JSON.stringify(args)}\n`)
  if (typeof args.delay_ms === 'number') await new Promise((resolve) => setTimeout(resolve, args.delay_ms))
  if (name === 'ControlStatus' && HANG_RELEASE) await new Promise(() => {})
  if (name === 'ControlStatus' && FAIL_RELEASE) return { isError: true, content: [{ type: 'text', text: 'release failed' }] }
  return { content: [{ type: 'text', text: `ok:${name}` }] }
})
await server.connect(new StdioServerTransport())
