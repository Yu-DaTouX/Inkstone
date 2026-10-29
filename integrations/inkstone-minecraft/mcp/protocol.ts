export interface ToolContent {
  type: 'text' | 'image'
  text?: string
  data?: string
  mimeType?: string
}

export interface ToolResult {
  content: ToolContent[]
  isError?: boolean
}

export interface ToolDefinition {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: Record<string, unknown>
  run(args: Record<string, unknown>): Promise<ToolResult>
}

interface RpcRequest {
  jsonrpc: '2.0'
  id?: number | string | null
  method: string
  params?: Record<string, unknown>
}

export const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']

export function text(value: string): ToolResult {
  return { content: [{ type: 'text', text: value }] }
}

export function image(png: Buffer, caption?: string): ToolResult {
  const content: ToolContent[] = [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }]
  if (caption) content.push({ type: 'text', text: caption })
  return { content }
}

export function failure(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

export interface ServerInfo {
  name: string
  version: string
  instructions: string
}

export async function handleMessage(value: unknown, tools: ToolDefinition[], info: ServerInfo): Promise<Record<string, unknown> | null> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: '无效的 JSON-RPC 请求' } }
  const message = value as RpcRequest
  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string' || (message.id !== undefined && message.id !== null && typeof message.id !== 'string' && (typeof message.id !== 'number' || !Number.isFinite(message.id)))) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: '无效的 JSON-RPC 请求' } }
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: message.id ?? null, result })
  const error = (code: number, text: string) => ({ jsonrpc: '2.0', id: message.id ?? null, error: { code, message: text } })
  const isRequest = message.id !== undefined
  if (message.params !== undefined && (!message.params || typeof message.params !== 'object' || Array.isArray(message.params))) return isRequest ? error(-32602, 'params 必须是对象') : null
  if (!isRequest) return null
  switch (message.method) {
    case 'initialize': {
      const requested = typeof message.params?.protocolVersion === 'string' ? message.params.protocolVersion : SUPPORTED_PROTOCOLS[0]
      return reply({
        protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: info.name, version: info.version },
        instructions: info.instructions
      })
    }
    case 'ping':
      return reply({})
    case 'tools/list':
      return reply({ tools: tools.map(({ run: _run, ...definition }) => definition) })
    case 'tools/call': {
      const name = typeof message.params?.name === 'string' ? message.params.name : ''
      const tool = tools.find((item) => item.name === name)
      if (!tool) return error(-32602, `未知工具 ${name}`)
      const args = message.params?.arguments ?? {}
      if (message.params?.arguments !== undefined && (!message.params.arguments || typeof message.params.arguments !== 'object' || Array.isArray(message.params.arguments))) return error(-32602, 'arguments 必须是对象')
      try {
        return reply(await tool.run(args as Record<string, unknown>))
      } catch (failureError) {
        return reply(failure(failureError instanceof Error ? failureError.message : String(failureError)))
      }
    }
    default:
      if (!isRequest) return null
      return error(-32601, `不支持的方法 ${message.method}`)
  }
}

export function serveStdio(tools: ToolDefinition[], info: ServerInfo, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): void {
  let buffer = ''
  const send = (value: unknown) => output.write(`${JSON.stringify(value)}\n`)
  input.setEncoding('utf8')
  input.on('data', (chunk: string) => {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
      if (!line) continue
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } })
        continue
      }
      void handleMessage(message, tools, info).then((response) => {
        if (response) send(response)
      }).catch(() => {
        send({ jsonrpc: '2.0', id: null, error: { code: -32603, message: '内部错误' } })
      })
    }
  })
  input.on('end', () => process.exit(0))
}
