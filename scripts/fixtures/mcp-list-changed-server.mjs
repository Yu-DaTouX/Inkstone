import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const tool = (name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } })
let grown = 0
let listed = 0
const mode = process.argv[2]

const server = new Server({ name: 'yan-list-changed-fixture', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } })
server.setRequestHandler(ListToolsRequestSchema, async ({ params }) => {
  if (mode === '--changes-on-every-list') {
    await server.sendToolListChanged()
    return { tools: [tool('never-stable')] }
  }
  if (mode === '--changes-during-pagination' || mode === '--invalidated-cursor') {
    if (params?.cursor === 'old-page') {
      listed++
      await server.sendToolListChanged()
      if (mode === '--invalidated-cursor') throw new Error('invalidated cursor')
      return { tools: [tool('old-tail')], nextCursor: 'old-page' }
    }
    if (!listed) return { tools: [tool('old-head')], nextCursor: 'old-page' }
    return { tools: [tool('new-head'), tool('new-tail')] }
  }
  return { tools: [
    ...(grown < 3 ? [tool('note')] : []),
    ...(grown < 3 ? [tool('grow')] : [{ ...tool('grow'), description: 'updated grow', inputSchema: { type: 'object', properties: { updated: { type: 'boolean' } } } }]),
    ...Array.from({ length: grown }, (_, index) => tool(`late${index + 1}`))
  ] }
})
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'grow') {
    grown += 1
    setTimeout(() => { void server.sendToolListChanged().catch(() => undefined) }, 20)
    return { content: [{ type: 'text', text: `grown:${grown}` }] }
  }
  return { content: [{ type: 'text', text: 'note' }] }
})
await server.connect(new StdioServerTransport())
