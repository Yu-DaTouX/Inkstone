import { createInterface } from 'node:readline'

const endpoint = process.env.INKSTONE_PI_MCP_URL ?? ''
const authorization = process.env.INKSTONE_PI_MCP_AUTH ?? ''
if (!/^http:\/\/127\.0\.0\.1:[0-9]+\/mcp(?:\/[a-zA-Z0-9_-]{1,64})?$/.test(endpoint) || !/^Bearer [0-9a-f]{64}$/.test(authorization)) process.exit(2)
const headers = { Authorization: authorization, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  let request
  try { request = JSON.parse(line) } catch { continue }
  try {
    if (request.method === 'ping') {
      if (request.id !== undefined) send({ jsonrpc: '2.0', id: request.id, result: {} })
      continue
    }
    const response = await fetch(endpoint, { method: 'POST', headers, body: line, redirect: 'error', signal: AbortSignal.timeout(180_000) })
    if (!response.ok) throw new Error('Host bridge unavailable')
    if (request.id !== undefined) send(await response.json())
  } catch {
    if (request.id !== undefined) send({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'Inkstone MCP bridge unavailable' } })
  }
}
