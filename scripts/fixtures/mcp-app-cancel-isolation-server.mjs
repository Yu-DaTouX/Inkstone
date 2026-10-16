import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const LOG = process.env.YAN_CANCEL_FIXTURE_LOG
function log(line) {
  if (!LOG) return
  try {
    appendFileSync(LOG, `${line}\n`)
  } catch {
  }
}

const PAGE2_DELAY_MS = Number(process.env.YAN_CANCEL_FIXTURE_PAGE2_DELAY_MS ?? 0)
const RAW_DELAY_MS = Number(process.env.YAN_CANCEL_FIXTURE_RAW_DELAY_MS ?? 400)
const delay = (ms) => new Promise((done) => setTimeout(done, ms))

const TOOLS = [
  { name: 'echo', description: '立即回显', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: 'slow', description: '挂起直到被取消', inputSchema: { type: 'object', properties: {} } },
  { name: 'fail', description: '返回一个服务端 JSON-RPC 错误', inputSchema: { type: 'object', properties: {} } },
  { name: 'die', description: '让 stdio 进程退出（模拟 transport 死亡）', inputSchema: { type: 'object', properties: {} } }
]
const PAGE_SIZE = 2

function createSdkInstance() {
  const server = new Server({ name: 'yan-cancel-fixture', version: '1.0.0' }, { capabilities: { tools: {} } })

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const start = request.params?.cursor ? Number(request.params.cursor) : 0
    if (start > 0) await delay(PAGE2_DELAY_MS)
    const slice = TOOLS.slice(start, start + PAGE_SIZE)
    const next = start + PAGE_SIZE < TOOLS.length ? String(start + PAGE_SIZE) : undefined
    return { tools: slice, ...(next ? { nextCursor: next } : {}) }
  })

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params?.name
    const args = request.params?.arguments ?? {}
    if (name === 'echo') {
      return {
        content: [{ type: 'text', text: `echo:${String(args.text ?? '')}` }],
        structuredContent: { echo: String(args.text ?? '') }
      }
    }
    if (name === 'slow') {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 30_000)
        const onAbort = () => {
          clearTimeout(timer)
          log('cancelled')
          reject(new Error('slow 已被取消'))
        }
        if (extra.signal.aborted) onAbort()
        else extra.signal.addEventListener('abort', onAbort, { once: true })
      }).catch(() => {
        throw new Error('slow 已被取消')
      })
      return { content: [{ type: 'text', text: 'slow-done' }] }
    }
    if (name === 'fail') throw new Error('fixture failure')
    if (name === 'die') {
      setTimeout(() => process.exit(7), 15)
      await new Promise(() => {})
    }
    if (name === 'exit') {
      setTimeout(() => process.exit(9), 60)
      return { content: [{ type: 'text', text: 'exit-scheduled' }] }
    }
    throw new Error(`未知工具：${String(name)}`)
  })

  return server
}

async function runRaw() {
  const { createInterface } = await import('node:readline')
  const rl = createInterface({ input: process.stdin })
  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
  rl.on('line', (line) => {
    const text = line.trim()
    if (!text) return
    let message
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    if (message.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'yan-cancel-raw-fixture', version: '1.0.0' }
        }
      })
      return
    }
    if (message.method === 'notifications/initialized') return
    if (message.method === 'notifications/cancelled') {
      log('cancelled-ignored')
      return
    }
    if (message.method === 'tools/list') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          tools: [
            { name: 'echo', description: 'raw 回显', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
            { name: 'slow', description: 'raw 无视取消', inputSchema: { type: 'object', properties: {} } }
          ]
        }
      })
      return
    }
    if (message.method === 'tools/call') {
      const name = message.params?.name
      if (name === 'echo') {
        send({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            content: [{ type: 'text', text: `raw:${String(message.params?.arguments?.text ?? '')}` }],
            structuredContent: { raw: true, pid: process.pid }
          }
        })
        return
      }
      if (name === 'app-error') {
        send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32000, message: 'application error: tool exploded' }
        })
        return
      }
      if (name === 'slow') {
        setTimeout(() => {
          log('late-result-sent')
          send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'raw-late-done' }] } })
        }, RAW_DELAY_MS)
        return
      }
    }
    if (message.id !== undefined) {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `未知方法：${String(message.method)}` } })
    }
  })
}

if (process.argv.includes('--raw')) {
  await runRaw()
} else if (process.argv.includes('--http')) {
  const port = Number(process.env.YAN_CANCEL_FIXTURE_HTTP_PORT ?? 39551)
  const http = createServer((req, res) => {
    if (!req.url || !req.url.startsWith('/mcp')) {
      res.statusCode = 404
      res.end('not found')
      return
    }
    void (async () => {
      const instance = createSdkInstance()
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
    process.stderr.write(`yan-cancel-fixture listening on 127.0.0.1:${port}/mcp\n`)
  })
} else {
  await createSdkInstance().connect(new StdioServerTransport())
}
