/**
 * 按调用取消隔离的合成服务器（FIX2 专用，不动 A1 既有 fixture）。
 *
 * 同一份实现支持三种模式：
 *   · `--stdio`（默认）—— 用官方 SDK `Server`，`slow` 尊重 `notifications/cancelled`
 *     （`extra.signal` 中止时结束），用于验证 A 取消/超时不影响同一连接上的 B；
 *   · `--http` —— 同样的 SDK 实现走 Streamable HTTP，用于验证 HTTP 传输；
 *   · `--raw` —— 手写的最小 JSON-RPC stdio 服务，**故意无视** `notifications/cancelled`，
 *     在客户端中止后仍发送迟到成功结果，用来验证「服务无视取消时，客户端在本调用级
 *     忽略迟到结果、不拆其他请求」；其中 `app-error` 返回 code=-32000 的**应用错误**
 *     （不关 transport），用来证明不能仅凭码值判定断线。
 *
 * 不联网：HTTP 只监听 127.0.0.1 的随机端口；不碰用户配置；不调用真实模型。
 *
 * 环境变量：
 *   YAN_CANCEL_FIXTURE_LOG            取消通知/迟到计数的追加日志路径（可空）
 *   YAN_CANCEL_FIXTURE_HTTP_PORT      `--http` 监听端口
 *   YAN_CANCEL_FIXTURE_PAGE2_DELAY_MS `tools/list` 第二页的延迟（分页取消用，默认 0）
 *   YAN_CANCEL_FIXTURE_RAW_DELAY_MS   `--raw` 的 `slow` 无视取消后的回复延迟（默认 400）
 */
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
    /* 日志失败不影响协议行为 */
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

/* ---------------------------------------------------------------- SDK 模式 */

function createSdkInstance() {
  const server = new Server({ name: 'yan-cancel-fixture', version: '1.0.0' }, { capabilities: { tools: {} } })

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const start = request.params?.cursor ? Number(request.params.cursor) : 0
    if (start > 0) await delay(PAGE2_DELAY_MS) // 第二页故意慢，供分页取消使用
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
      await new Promise(() => {}) // 永不回复；进程退出会让 transport 关闭
    }
    if (name === 'exit') {
      /* 先成功回复，稍后进程自行退出：模拟服务空闲退出，客户端应通过 onclose 及时回收。 */
      setTimeout(() => process.exit(9), 60)
      return { content: [{ type: 'text', text: 'exit-scheduled' }] }
    }
    throw new Error(`未知工具：${String(name)}`)
  })

  return server
}

/* ------------------------------------------------------- 手写 JSON-RPC 模式 */

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
      log('cancelled-ignored') // 故意无视取消
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
        /* 服务端正常返回的 JSON-RPC 应用错误，码故意用 -32000：它并不表示 transport 已死。
           旧实现只看码值会误把健康连接（含并发 B）一并拆掉。message 明确标注是应用错误。 */
        send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32000, message: 'application error: tool exploded' }
        })
        return
      }
      if (name === 'slow') {
        /* 无视取消：延迟后照样发成功结果，验证客户端在调用级丢弃迟到。 */
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

/* -------------------------------------------------------------------- 入口 */

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
