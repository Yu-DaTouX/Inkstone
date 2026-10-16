import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'

const [port, reqLog, mode] = process.argv.slice(2)
const MARKER = 's1-marker.txt'
const TOOL_COMMAND = process.env.S1_TOOL_COMMAND || `node -e "require('fs').writeFileSync('${MARKER}','x')"`
let n = 0

const chunk = (delta, finish) => ({
  id: 'mock-cmpl',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'mock',
  choices: [{ index: 0, delta, finish_reason: finish ?? null }]
})

function sse(res, parts) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  })
  for (const p of parts) res.write(`data: ${JSON.stringify(p)}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

createServer((req, res) => {
  let body = ''
  req.on('data', (d) => (body += d))
  req.on('end', () => {
    n += 1
    let parsed = {}
    try {
      parsed = JSON.parse(body)
    } catch {
    }
    const messages = parsed.messages ?? []
    const bodyChars = body.length
    appendFileSync(
      reqLog,
      JSON.stringify({
        at: new Date().toISOString(),
        n,
        url: req.url,
        model: parsed.model,
        messageCount: messages.length,
        roles: messages.map((m) => m.role),
        toolResultCount: messages.filter((m) => m.role === 'tool').length,
        bodyChars,
        stream: parsed.stream === true,
        toolNames: (parsed.tools ?? []).map((t) => t.function?.name)
      }) + '\n'
    )

    if (mode === 'block' && n === 1) {
      sse(res, [
        chunk({
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              index: 0,
              id: 'call_s1_1',
              type: 'function',
              function: {
                name: 'bash',
                arguments: JSON.stringify({
                  command: TOOL_COMMAND
                })
              }
            }
          ]
        }),
        chunk({}, 'tool_calls')
      ])
      return
    }

    sse(res, [
      chunk({ role: 'assistant', content: mode === 'block' ? 'S1-DONE' : 'S1-PLAIN' }),
      chunk({}, 'stop')
    ])
  })
}).listen(Number(port), '127.0.0.1', () => {
  appendFileSync(reqLog, JSON.stringify({ at: new Date().toISOString(), n: 0, event: 'listening' }) + '\n')
})
