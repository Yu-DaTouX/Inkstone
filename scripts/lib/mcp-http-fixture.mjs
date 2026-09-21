/**
 * MCP 远程（HTTP）fixture server（实施-04 §5）。
 *
 * 与 stdio fixture 同一目的：让「远程 MCP」这条传输路径也被**真连接**验过一次，
 * 而不是只在契约里写一句「支持 http」。用官方 SDK 的 `StreamableHTTPServerTransport`，
 * 所以验的是真实协议（初始化握手、JSON-RPC over HTTP），不是我们编的假接口。
 *
 * 监听 127.0.0.1 的固定端口（默认 39321，可用 `YAN_MCP_HTTP_PORT` 覆盖）——
 * 只在本机回环上，不对外暴露；被占用时进程直接失败（宁可红，不静默跳过）。
 *
 * ⚠️ 无状态模式下**每个请求都要新建 server + transport**：共用一个 transport
 * 在 `sessionIdGenerator: undefined` 时会 500（首次冒烟实测踩到）。
 *
 * 工具集比 stdio fixture 小：HTTP 这一层只需要一个能回结果的与一个能失败的，
 * 其余行为（分页 / annotations / 大结果）在 stdio 上已经验过。
 */
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
      /* JSON 响应比 SSE 流更好排障，也够 fixture 用。 */
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
  /* 就绪信号走 stderr：stdout 留给协议 / 上层日志。 */
  process.stderr.write(`yan-mcp-http-fixture listening on 127.0.0.1:${PORT}/mcp\n`)
})
