import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [projectDir, outDir, ...calls] = process.argv.slice(2)
if (!projectDir || !outDir) {
  console.error('用法：node scripts/smoke-dev-mcp.ts <项目目录> <输出目录> [工具名=JSON参数 ...]')
  process.exit(2)
}
await mkdir(outDir, { recursive: true })
const server = spawn(process.execPath, ['--no-warnings', fileURLToPath(new URL('../mcp/server.ts', import.meta.url))], {
  env: { ...process.env, INKSTONE_MC_PROJECT: projectDir },
  stdio: ['pipe', 'pipe', 'pipe']
})
server.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk.toString().split('\n').filter((line) => line && !line.startsWith('[gradle]')).map((line) => `  [server] ${line}\n`).join('')))
let buffer = ''
const waiting = new Map<number, (value: Record<string, unknown>) => void>()
server.stdout.on('data', (chunk: Buffer) => {
  buffer += chunk.toString()
  let index = buffer.indexOf('\n')
  while (index >= 0) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    index = buffer.indexOf('\n')
    if (!line.trim()) continue
    const message = JSON.parse(line) as { id?: number }
    if (typeof message.id === 'number') waiting.get(message.id)?.(message as Record<string, unknown>)
  }
})
let nextId = 1
function request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const id = nextId++
  return new Promise((resolve) => {
    waiting.set(id, resolve)
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}

const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } })
server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
console.log('initialize →', JSON.stringify((init.result as Record<string, unknown>).serverInfo))
const list = await request('tools/list')
console.log('tools →', ((list.result as { tools: Array<{ name: string }> }).tools ?? []).map((tool) => tool.name).join(', '))
let step = 0
for (const call of calls) {
  const split = call.indexOf('=')
  const name = split > 0 ? call.slice(0, split) : call
  const args = split > 0 ? (JSON.parse(call.slice(split + 1)) as Record<string, unknown>) : {}
  step += 1
  const started = Date.now()
  const response = await request('tools/call', { name, arguments: args })
  const result = response.result as { content?: Array<{ type: string; text?: string; data?: string }>; isError?: boolean } | undefined
  console.log(`\n=== ${step}. ${name} ${JSON.stringify(args)}（${Date.now() - started}ms）${result?.isError ? ' [isError]' : ''}`)
  if (response.error) console.log(JSON.stringify(response.error))
  for (const [index, content] of (result?.content ?? []).entries()) {
    if (content.type === 'image' && content.data) {
      const file = join(outDir, `mcp-${String(step).padStart(2, '0')}-${name}-${index}.png`)
      await writeFile(file, Buffer.from(content.data, 'base64'))
      console.log(`[image] ${file}`)
    } else if (content.text) {
      console.log(content.text.length > 4000 ? `${content.text.slice(0, 4000)}\n…（截断 ${content.text.length - 4000} 字）` : content.text)
    }
  }
}
server.stdin.end()
