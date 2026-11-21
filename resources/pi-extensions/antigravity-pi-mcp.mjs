import { createInterface } from 'node:readline'

const endpoint = process.env.INKSTONE_PI_MCP_URL ?? ''
const authorization = process.env.INKSTONE_PI_MCP_AUTH ?? ''
if (!/^http:\/\/127\.0\.0\.1:[0-9]+\/mcp(?:\/[a-zA-Z0-9_-]{1,64})?$/.test(endpoint) || !/^Bearer [0-9a-f]{64}$/.test(authorization)) process.exit(2)
const headers = { Authorization: authorization, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
const MAX_IN_FLIGHT = 32
const inFlight = new Set()

const forward = async (line, id) => {
  try {
    const response = await fetch(endpoint, { method: 'POST', headers, body: line, redirect: 'error', signal: AbortSignal.timeout(180_000) })
    if (!response.ok) throw new Error('Host bridge unavailable')
    if (id !== undefined) send(await response.json())
  } catch {
    if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Inkstone MCP bridge unavailable' } })
  }
}

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  let request
  try { request = JSON.parse(line) } catch { continue }
  if (request.method === 'ping') {
    if (request.id !== undefined) send({ jsonrpc: '2.0', id: request.id, result: {} })
    continue
  }
  if (inFlight.size >= MAX_IN_FLIGHT) {
    if (request.id !== undefined) send({ jsonrpc: '2.0', id: request.id, error: { code: -32001, message: 'Too many concurrent Inkstone MCP requests' } })
    continue
  }
  const task = forward(line, request.id).finally(() => inFlight.delete(task))
  inFlight.add(task)
}
await Promise.allSettled(inFlight)
