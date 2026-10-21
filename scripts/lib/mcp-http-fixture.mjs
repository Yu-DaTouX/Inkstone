import { createServer } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const PORT = Number(process.env.YAN_MCP_HTTP_PORT ?? 39321)

const TOOLS = [
  {
    name: 'echo',
    description: '把 text 原样回显（HTTP fixture）。',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
  },
  {
    name: 'boom',
    description: '总是失败（HTTP fixture）：验证工具级错误走 HTTP 也一样可区分。',
    inputSchema: { type: 'object', properties: {}, required: [] }
  }
]

function createServerInstance() {
  const instance = new Server(
    { name: 'yan-mcp-http-fixture', version: '1.0.0' },
    { capabilities: { tools: {} } }
  )
  instance.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))
  instance.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params?.name
    const args = request.params?.arguments ?? {}
    if (name === 'echo') return { content: [{ type: 'text', text: `http:${String(args.text ?? '')}` }] }
    if (name === 'boom') return { isError: true, content: [{ type: 'text', text: 'http fixture 固定失败' }] }
    return { isError: true, content: [{ type: 'text', text: `未知工具：${String(name)}` }] }
  })
  return instance
}

const http = createServer((req, res) => {
  if (!req.url || !req.url.startsWith('/mcp')) {
    res.statusCode = 404
    res.end('not found')
    return
  }
  void (async () => {
    const instance = createServerInstance()
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    })
    res.on('close', () => {
      void transport.close().catch(() => undefined)
      void instance.close().catch(() => undefined)
    })
    await instance.connect(transport)
    await transport.handleRequest(req, res)
  })().catch(() => {
    if (!res.headersSent) res.statusCode = 500
    res.end()
  })
})

http.listen(PORT, '127.0.0.1', () => {
  const bound = http.address()
  const port = typeof bound === 'object' && bound ? bound.port : PORT
  process.stderr.write(`yan-mcp-http-fixture listening on 127.0.0.1:${port}/mcp\n`)
})

http.on('error', (error) => {
  process.stderr.write(`yan-mcp-http-fixture 起不来（127.0.0.1:${PORT}）：${error?.message ?? error}\n`)
  process.exit(1)
})
