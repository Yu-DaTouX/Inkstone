import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')

async function loadSpec() {
  const override = process.env.YAN_MCP_APP_SPEC_MODULE
  if (override) return import(pathToFileURL(resolve(override)).href)
  const { build } = await import('esbuild')
  const outfile = join(tmpdir(), `yan-mcp-app-spec-${process.pid}.mjs`)
  await build({
    entryPoints: [join(REPO_ROOT, 'src/main/mcp/app-spec.ts')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
  return import(pathToFileURL(outfile).href)
}

const spec = await loadSpec()
const APP_MIME = spec.MCP_APP_MIME_TYPE
const UI_META = spec.MCP_APP_META_UI

const UI_RESOURCE_URI = 'ui://mcp-app/dashboard.html'
const HUGE_RESOURCE_URI = 'ui://mcp-app/huge.html'
const PLAIN_RESOURCE_URI = 'ui://mcp-app/plain.txt'
const UI_CSP = {
  connectDomains: ['https://api.example.invalid'],
  resourceDomains: ['https://cdn.example.invalid'],
  frameDomains: ['https://evil.invalid'],
  baseUriDomains: ['https://app.example.invalid']
}

const DASHBOARD_HTML = '<!doctype html><html><head><title>合成 App</title></head><body><button id="go">刷新</button></body></html>'

const TOOLS = [
  {
    name: 'read_only_note',
    description: '只读工具（fixture）：返回文本并声明 App 页面。',
    annotations: { readOnlyHint: true, destructiveHint: false },
    _meta: { [UI_META]: { resourceUri: UI_RESOURCE_URI, csp: UI_CSP, visibility: ['model', 'app'] } },
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: [] }
  },
  {
    name: 'app_only_refresh',
    description: '仅 App 可见的工具（fixture）：模型不应注册它。',
    annotations: { readOnlyHint: true },
    _meta: { [UI_META]: { visibility: ['app'] } },
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'no_visibility_note',
    description: '不声明 visibility 的工具（fixture）：按规范同时向模型和 App 开放。',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'client_capabilities',
    description: '回显客户端 initialize 声明的能力（fixture）。',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'slow',
    description: '挂起直到被取消（fixture）：验证每调用取消。',
    inputSchema: { type: 'object', properties: {}, required: [] }
  }
]

const RESOURCES = [
  { uri: UI_RESOURCE_URI, name: 'dashboard', mimeType: APP_MIME },
  { uri: HUGE_RESOURCE_URI, name: 'huge', mimeType: APP_MIME },
  { uri: PLAIN_RESOURCE_URI, name: 'plain', mimeType: 'text/plain' }
]

function createInstance() {
  const server = new Server(
    { name: 'yan-mcp-app-fixture', version: '1.0.0' },
    { capabilities: { tools: {}, resources: {} } }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: RESOURCES }))
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params?.uri
    if (uri === UI_RESOURCE_URI) {
      return {
        contents: [{ uri, mimeType: APP_MIME, text: DASHBOARD_HTML, _meta: { [UI_META]: { csp: UI_CSP } } }]
      }
    }
    if (uri === HUGE_RESOURCE_URI) {
      return { contents: [{ uri, mimeType: APP_MIME, text: 'x'.repeat(4096), _meta: { [UI_META]: { csp: UI_CSP } } }] }
    }
    if (uri === PLAIN_RESOURCE_URI) {
      return { contents: [{ uri, mimeType: 'text/plain', text: 'not an app' }] }
    }
    throw new Error(`未知资源：${String(uri)}`)
  })

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params?.name
    const args = request.params?.arguments ?? {}
    if (name === 'read_only_note') {
      return {
        content: [{ type: 'text', text: `note:${String(args.text ?? '')}` }],
        structuredContent: { note: String(args.text ?? ''), app: true },
        _meta: { [UI_META]: { resourceUri: UI_RESOURCE_URI, csp: UI_CSP } }
      }
    }
    if (name === 'app_only_refresh') {
      return { content: [{ type: 'text', text: 'refreshed' }], structuredContent: { refreshed: true } }
    }
    if (name === 'no_visibility_note') {
      return { content: [{ type: 'text', text: 'plain' }] }
    }
    if (name === 'client_capabilities') {
      return {
        content: [{ type: 'text', text: 'capabilities' }],
        structuredContent: { clientCapabilities: server.getClientCapabilities() ?? null }
      }
    }
    if (name === 'slow') {
      await new Promise((resolvePromise, rejectPromise) => {
        const timer = setTimeout(resolvePromise, 30_000)
        if (extra.signal.aborted) {
          clearTimeout(timer)
          rejectPromise(new Error('cancelled'))
          return
        }
        extra.signal.addEventListener('abort', () => {
          clearTimeout(timer)
          rejectPromise(new Error('cancelled'))
        }, { once: true })
      }).catch(() => {
        throw new Error('slow 已被取消')
      })
      return { content: [{ type: 'text', text: '不该走到这里' }] }
    }
    return { isError: true, content: [{ type: 'text', text: `未知工具：${String(name)}` }] }
  })

  return server
}

if (process.argv.includes('--http')) {
  const port = Number(process.env.YAN_MCP_APP_HTTP_PORT ?? 39351)
  const http = createServer((req, res) => {
    if (!req.url || !req.url.startsWith('/mcp')) {
      res.statusCode = 404
      res.end('not found')
      return
    }
    void (async () => {
      const instance = createInstance()
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
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
  http.listen(port, '127.0.0.1', () => {
    process.stderr.write(`yan-mcp-app-fixture listening on 127.0.0.1:${port}/mcp\n`)
  })
} else {
  await createInstance().connect(new StdioServerTransport())
}
