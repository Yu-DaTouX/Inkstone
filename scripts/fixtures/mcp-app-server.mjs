/**
 * MCP Apps 合成服务器。
 *
 * 同一份实现支持 `--stdio` 与 `--http`，被 `scripts/test-mcp-app-host.mjs`
 * 真连一次，验的是真实协议（握手、tools/list、tools/call、resources/read），
 * 而不是我们编的假接口。它**不联网**：声明的 CSP 域名都是 `.invalid`。
 *
 * 暴露的内容刻意选过：
 *   · `read_only_note`      —— 只读工具，带 `_meta.ui.resourceUri` 与 `csp`；
 *   · `app_only_refresh`    —— `visibility:['app']` 的工具（模型不应注册/调用）；
 *   · `no_visibility_note`  —— 不声明 visibility：宿主必须按最严「只给模型」；
 *   · `client_capabilities` —— 回显客户端 initialize 声明的能力（验 ui 能力声明）；
 *   · `slow`                —— 挂起直到被取消（验每调用取消）；
 *   · `ui://mcp-app/dashboard.html` —— 带 csp 的 App 页面；
 *   · `ui://mcp-app/huge.html`      —— 超过体积上限；
 *   · `ui://mcp-app/plain.txt`      —— MIME 不对，宿主必须拒。
 *
 * 规范字段（MIME、扩展标识、`_meta` 键）不在这里另写一遍：从 `src/main/mcp/app-spec.ts`
 * 取值。默认现场用 esbuild 编译该模块；测试脚本可用 `YAN_MCP_APP_SPEC_MODULE`
 * 指向已编译好的同一模块，避免重复编译。
 *
 * 用法：
 *   node scripts/fixtures/mcp-app-server.mjs --stdio
 *   node scripts/fixtures/mcp-app-server.mjs --http   # 端口见 YAN_MCP_APP_HTTP_PORT
 */
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

/** 规范常量来自 `src/main/mcp/app-spec.ts`（唯一来源）。 */
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
    platform: 'neutral',
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
/** 只声明 https 域名；宿主推导 CSP 时应剔除 frame/priv 等。 */
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
    description: '不声明 visibility 的工具（fixture）：应按最严只给模型。',
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
      /* 尊重取消：连接被丢弃 / 请求被取消时立刻结束，不留挂起的定时器。 */
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
