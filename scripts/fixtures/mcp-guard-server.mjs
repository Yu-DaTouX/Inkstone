/**
 * MCP 注解审批夹具服务（合集 05 原生核对）。
 *
 * 一个**真实**的 MCP stdio 服务（官方 SDK `Server` + `StdioServerTransport`），
 * 只暴露五个刻意挑选的注解组合，供 `scripts/test-mcp-guard-native.mjs` 用随包 pi 1.2.0
 * 真实连接、listTools、callTool：
 *
 *   · `read_ok`          —— `readOnlyHint: true`（只读，不该问）
 *   · `no_annotations`   —— 完全不带注解（缺注解，该问）
 *   · `destructive_op`   —— `destructiveHint: true`（破坏，该问）
 *   · `read_destructive` —— `readOnlyHint: true` + `destructiveHint: true`（破坏优先，该问）
 *   · `safe_local`       —— `destructiveHint: false` + `openWorldHint: false`（明确安全，不该问）
 *
 * 边界：任何处理器只返回一段字符串，并向 `MCP_GUARD_MARKER` 追加一行
 * `invoked:<工具名>` 作为「服务端真的执行过」的磁盘物证。不删除、不写用户文件、
 * 不访问网络；所有键都是夹具。
 *
 * 既能被 pi 作为子进程拉起（直接执行本文件），也能被测试 `import` 取工具定义
 * （此时不连接 transport）。
 */
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

/** 工具定义：`annotations` 会被原样交给 ListTools 响应，缺省即完全不写该字段。 */
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
