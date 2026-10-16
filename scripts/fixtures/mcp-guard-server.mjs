import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

export const GUARD_TOOLS = [
  { name: 'read_ok', annotations: { readOnlyHint: true } },
  { name: 'no_annotations' },
  { name: 'destructive_op', annotations: { destructiveHint: true } },
  { name: 'read_destructive', annotations: { readOnlyHint: true, destructiveHint: true } },
  { name: 'safe_local', annotations: { destructiveHint: false, openWorldHint: false } }
]

const MARKER = process.env.MCP_GUARD_MARKER ?? ''

function listedTools() {
  return GUARD_TOOLS.map((tool) => ({
    name: tool.name,
    description: `guard fixture tool ${tool.name}`,
    inputSchema: { type: 'object', properties: {}, required: [] },
    ...(tool.annotations ? { annotations: tool.annotations } : {})
  }))
}

async function main() {
  const server = new Server(
    { name: 'yan-mcp-guard-fixture', version: '1.0.0' },
    { capabilities: { tools: {} } }
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listedTools() }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = String(request.params?.name ?? '')
    if (MARKER) appendFileSync(MARKER, `invoked:${name}\n`)
    return { content: [{ type: 'text', text: `ok:${name}` }] }
  })
  await server.connect(new StdioServerTransport())
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) await main()
