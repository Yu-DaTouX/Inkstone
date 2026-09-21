/*
 * 假 provider（OpenAI chat-completions 兼容的最小实现）。
 *
 * ── 为什么要有它 ──
 * 有些问题真实模型答不了：**「第 N 个请求到底发出去了没有」**。
 * 预算门（实施-05 §6）、压缩时序（实施-06）、模式切换的生效点，判据都是
 * 「请求序号 + 请求体内容 + 钩子时序」—— 真实模型既不可复现，也看不见网络层。
 *
 * 这里把「第几次请求回什么」写死，并把每个收到的请求原样追加进 JSONL：
 * 于是「拦下没拦下」不再是推断，而是一份可以直接读的请求清单。
 *
 * ── 用法 ──
 *   node scripts/lib/mock-provider.mjs <port> <reqLogPath> <mode>
 *     mode=block  第 1 次请求回一个 bash 工具调用（写相对路径 s1-marker.txt），之后回文本
 *     mode=plain  每次都回纯文本
 * 配合 `scripts/hook-probe.mjs` 使用（它会拉起本文件并读 req log）。
 *
 * ⚠️ 工具命令里的路径必须是**相对路径**（或正斜杠）：命令会被拼进 JS 字符串字面量，
 *    反斜杠会被当转义吃掉，文件会写到你没想到的地方（实测踩过）。
 */
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'

const [port, reqLog, mode] = process.argv.slice(2)
const MARKER = 's1-marker.txt'
/*
 * 让调用方指定「模型要求执行的那条命令」：钩子/门禁实验要对比
 * 「同一条命令在不同模式下到底执行没执行」，命令写死就没法做对照。
 */
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
      /* 不是 JSON 也要记一笔：否则「请求发出去了」这件事会被整段漏掉 */
    }
    const messages = parsed.messages ?? []
    /*
     * `bodyChars`：请求体的真实体积（字符）。预算门（实施-05 S4）的判据是
     * 「钩子里的估算 vs 真实请求」，只记条数是没法校准估算的。
     */
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
