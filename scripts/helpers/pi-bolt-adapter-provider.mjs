// Deterministic local OpenAI-compatible provider for the PB2 native-exe adapter tests.
// Loopback only, no real credentials, no network egress. Scripted tool calls then a fixed stream.
import http from 'node:http'

const defaults = {
  chunks: 4,
  chunkDelayMs: 0,
  chunkSize: 32,
  textChar: 'x',
  readFile: '',
  writeFile: '',
  writeContent: 'pb2-adapter write-back\n'
}

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`)
}

function baseChunk(model) {
  return { id: 'chatcmpl-pb2', object: 'chat.completion.chunk', created: 1700000000, model }
}

function toolCallChunk(model, name, args, id) {
  return {
    ...baseChunk(model),
    choices: [{
      index: 0,
      delta: { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: args } }] },
      finish_reason: null
    }]
  }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

function defaultTools(config) {
  return [
    { name: 'read', args: { path: config.readFile } },
    { name: 'write', args: { path: config.writeFile, content: config.writeContent } }
  ]
}

export function startProvider({ port = 0, ...overrides } = {}) {
  const config = { ...defaults, ...overrides }
  const tools = config.tools || defaultTools(config)
  const stats = { requests: 0, toolCalls: 0, streamedChunks: 0 }
  const streamText = async (res, model) => {
    for (let i = 0; i < config.chunks; i++) {
      sse(res, {
        ...baseChunk(model),
        choices: [{ index: 0, delta: { content: config.textChar.repeat(config.chunkSize) }, finish_reason: null }]
      })
      stats.streamedChunks += 1
      if (config.chunkDelayMs > 0) await delay(config.chunkDelayMs)
    }
    sse(res, {
      ...baseChunk(model),
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 180, completion_tokens: config.chunks * config.chunkSize, total_tokens: 180 + config.chunks * config.chunkSize }
    })
  }
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', async () => {
      if (!req.url.endsWith('/chat/completions')) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{"error":"not found"}')
        return
      }
      let payload
      try { payload = JSON.parse(body) } catch { payload = {} }
      stats.requests += 1
      const model = payload.model || 'eval-model'
      const messages = Array.isArray(payload.messages) ? payload.messages : []
      const toolResults = messages.filter((m) => m.role === 'tool' || m.role === 'toolResult').length
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      if (toolResults < tools.length) {
        const step = tools[toolResults]
        stats.toolCalls += 1
        const args = typeof step.args === 'string' ? step.args : JSON.stringify(step.args)
        sse(res, toolCallChunk(model, step.name, args, step.id || `call_${toolResults}`))
        sse(res, {
          ...baseChunk(model),
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 100 + toolResults * 40, completion_tokens: 20 + toolResults * 4, total_tokens: 120 + toolResults * 44 }
        })
      } else {
        await streamText(res, model)
      }
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, stats, tools }))
  })
}
