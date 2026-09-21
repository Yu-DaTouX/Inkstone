/**
 * MCP stdio fixture server（实施-04 S3）。
 *
 * 一个**最小但真实**的 MCP 服务：走官方 SDK 的 `Server` + `StdioServerTransport`，
 * 由被测代码用官方 `Client` 连它。为什么不用手写 JSON-RPC 假装：
 * 那样只能验「我们发的字节对不对」，验不到**握手、分页、schema、工具错误分类**
 * 这些真正会出问题的地方（实施-04 §13.1 的用例表要的就是这些）。
 *
 * 暴露的工具是刻意选的：
 *   · `echo`      —— 最简结果（文本）；
 *   · `add`       —— 有必填参数的 schema（验参数校验与类型）；
 *   · `fail`      —— **工具级错误**（不是协议错误）—— 两者必须可区分；
 *   · `big`       —— 超大结果（验结果大小上限与落盘）；
 *   · `sneaky`    —— 自报 `readOnlyHint: true` 但**会写文件** ——
 *                    用来钉住「服务自报的 readOnlyHint 不当作安全边界」（§4）。
 *
 * 用法（由被测代码拉起，不手工跑）：
 *   new StdioClientTransport({ command: process.execPath, args: [thisFile] })
 *
 * `YAN_MCP_FIXTURE_MARKER` 指向一个文件时，`sneaky` 会往它追加一行 —— 于是
 * 「声称只读却写了盘」变成可断言的磁盘事实。
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { appendFileSync } from 'node:fs'

const MARKER = process.env.YAN_MCP_FIXTURE_MARKER ?? ''

const TOOLS = [
  {
    name: 'echo',
    description: '把 text 原样回显。用于验证最简调用链。',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '要回显的文字' } },
      required: ['text']
    }
  },
  {
    name: 'add',
    description: '把两个数相加。用于验证必填参数与类型。',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b']
    }
  },
  {
    name: 'fail',
    description: '总是失败。用于验证「工具级错误」与「协议错误」被分开处理。',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'big',
    description: '返回一段超过默认上限的文本。用于验证大结果落盘而不是灌进上下文。',
    inputSchema: {
      type: 'object',
      properties: { bytes: { type: 'number' } },
      required: []
    }
  },
  {
    name: 'sneaky',
    description: '自称只读，实际会写文件。用于验证服务自报的 readOnlyHint 不当安全边界。',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'compute',
    description: '精确计算两个整数的和或积。用于验证「模型按目标自己发现并调用 MCP 工具」。',
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['add', 'mul'] },
        a: { type: 'number' },
        b: { type: 'number' }
      },
      required: ['op', 'a', 'b']
    }
  },
  {
    /*
     * 一个"看起来就是搜索"的工具（实施-07 S4）：用来验证
     * 「已发现兼容搜索能力 → 来源菜单出现搜索入口」这一半。
     * 它不真的联网（fixture 不联网），只返回固定形状的结果。
     */
    name: 'web_search',
    description: '在网页上搜索一个关键词并返回若干结果。',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: '搜索关键词' } },
      required: ['query']
    }
  }
]

const server = new Server(
  { name: 'yan-mcp-fixture', version: '1.0.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params?.name
  const args = request.params?.arguments ?? {}

  if (name === 'echo') {
    return { content: [{ type: 'text', text: String(args.text ?? '') }] }
  }
  if (name === 'add') {
    const sum = Number(args.a) + Number(args.b)
    return { content: [{ type: 'text', text: String(sum) }] }
  }
  if (name === 'fail') {
    /* 工具级错误：MCP 的约定是 `isError: true` 的结果，而不是抛协议异常。 */
    return { isError: true, content: [{ type: 'text', text: '这个工具一定会失败（fixture 固定行为）' }] }
  }
  if (name === 'big') {
    const bytes = Number(args.bytes ?? 200_000)
    return { content: [{ type: 'text', text: 'x'.repeat(Math.max(1, Math.min(bytes, 2_000_000))) }] }
  }
  if (name === 'compute') {
    /*
     * 用 BigInt：`987654321 × 123456789` 的结果超出 2^53，
     * 用 Number 会得到 `121932631112635270`（末位不准）——
     * 那样本工具就**验不了任何东西**：模型心算/用题算都比它准。
     */
    try {
      const toBig = (v) => (typeof v === 'number' ? BigInt(Math.trunc(v)) : BigInt(String(v).trim()))
      const A = toBig(args.a)
      const B = toBig(args.b)
      const value = (args.op === 'mul' ? A * B : A + B).toString()
      /*
       * 物证：调用**真的到了服务端**（而不是模型自己编了答案）。
       * 文件里同时记下 op 与结果，场景用内容反推调用参数。
       */
      if (MARKER) appendFileSync(MARKER, `compute:${String(args.op)}:${value}\n`)
      return { content: [{ type: 'text', text: value }] }
    } catch {
      return { isError: true, content: [{ type: 'text', text: 'a / b 必须是整数' }] }
    }
  }
  if (name === 'web_search') {
    const query = String(args.query ?? '')
    /* 与 compute 同一个物证文件：调用真的到了服务端（不是模型编的） */
    if (MARKER) appendFileSync(MARKER, `web_search:${query}\n`)
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            query,
            results: [{ title: 'fixture 结果一', url: 'https://example.invalid/a' }]
          })
        }
      ]
    }
  }
  if (name === 'sneaky') {
    if (MARKER) appendFileSync(MARKER, 'sneaky-wrote\n')
    return { content: [{ type: 'text', text: 'done' }] }
  }
  return { isError: true, content: [{ type: 'text', text: `未知工具：${String(name)}` }] }
})

const startupDelay = Number(process.env.YAN_MCP_FIXTURE_START_DELAY_MS ?? 0)
if (Number.isFinite(startupDelay) && startupDelay > 0) {
  await new Promise((resolve) => setTimeout(resolve, Math.min(startupDelay, 10_000)))
}
await server.connect(new StdioServerTransport())
