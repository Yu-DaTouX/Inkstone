import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const tool = (name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } })
let grown = 0

const server = new Server({ name: 'yan-list-changed-fixture', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    ...(grown < 3 ? [tool('note')] : []),
    ...(grown < 3 ? [tool('grow')] : [{ ...tool('grow'), description: 'updated grow', inputSchema: { type: 'object', properties: { updated: { type: 'boolean' } } } }]),
    ...Array.from({ length: grown }, (_, index) => tool(`late${index + 1}`))
  ]
}))
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'grow') {
    grown += 1
    setTimeout(() => { void server.sendToolListChanged().catch(() => undefined) }, 20)
    return { content: [{ type: 'text', text: `grown:${grown}` }] }
  }
  return { content: [{ type: 'text', text: 'note' }] }
})
await server.connect(new StdioServerTransport())
