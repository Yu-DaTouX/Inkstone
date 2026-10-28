import { createServer } from 'node:http'
import { sleep } from './env.mjs'

function lastUserText(input) {
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i]
    if (item.role !== 'user') continue
    const content = item.content
    return typeof content === 'string' ? content : (content ?? []).map((part) => part.text ?? '').join('')
  }
  return ''
}

function toolOutputsSinceUser(input) {
  let count = 0
  for (let i = input.length - 1; i >= 0; i--) {
    if (input[i].role === 'user') break
    if (input[i].type === 'function_call_output') count++
  }
  return count
}

export function longText() {
  const parts = ['# 长文本流式测试\n\n这是一段用来检验流式渲染的长回复。\n\n']
  for (let i = 1; i <= 120; i++) parts.push(`- 列表第 ${i} 项：砚把模型输出逐字显示在界面上，这一行用来撑长末尾块。\n\n  补充说明 ${i}，缩进续行。\n`)
  parts.push('\n```ts\n')
  for (let i = 1; i <= 120; i++) parts.push(`const value${i} = compute(${i}, 'segment-${i}')\n`)
  parts.push('```\n\n| 列 A | 列 B | 列 C |\n| --- | --- | --- |\n')
  for (let i = 1; i <= 60; i++) parts.push(`| a${i} | b${i} | c${i} |\n`)
  parts.push('\n结束。\n')
  return parts.join('')
}

export const FAKE_TRIGGERS = {
  LONGTEXT: '约 20KB markdown 长文本，慢速逐块流出',
  MANYTOOLS: '连续 40 步，每步一句话加一次 bash 工具调用',
  BIGOUT: '一次 bash 输出 6000 行，期间分段停顿',
  FAIL: '返回 502，用来看模型错误与重试',
  APPROVAL: '一次命中危险规则的 bash（删除不存在的注册表项），用来看审批'
}

async function respond(res, text, done, requestNo) {
  const send = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  const id = `resp_${requestNo}`
  const output = []
  send({ type: 'response.created', response: { id, status: 'in_progress', output: [] } })
  const streamText = async (content, chunk, delay) => {
    const index = output.length
    const item = { id: `msg_${requestNo}_${index}`, type: 'message', role: 'assistant', status: 'in_progress', content: [] }
    send({ type: 'response.output_item.added', output_index: index, item })
    send({ type: 'response.content_part.added', item_id: item.id, output_index: index, content_index: 0, part: { type: 'output_text', text: '' } })
    for (let i = 0; i < content.length; i += chunk) {
      send({ type: 'response.output_text.delta', item_id: item.id, output_index: index, content_index: 0, delta: content.slice(i, i + chunk) })
      if (delay) await sleep(delay)
    }
    send({ type: 'response.output_text.done', item_id: item.id, output_index: index, content_index: 0, text: content })
    const finished = { ...item, status: 'completed', content: [{ type: 'output_text', text: content }] }
    send({ type: 'response.output_item.done', output_index: index, item: finished })
    output.push(finished)
  }
  const callTool = async (name, args) => {
    const index = output.length
    const item = { id: `fc_${requestNo}_${index}`, type: 'function_call', call_id: `call_${requestNo}_${index}`, name, arguments: '', status: 'in_progress' }
    send({ type: 'response.output_item.added', output_index: index, item })
    const raw = JSON.stringify(args)
    for (let i = 0; i < raw.length; i += 40) {
      send({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: index, delta: raw.slice(i, i + 40) })
      await sleep(5)
    }
    send({ type: 'response.function_call_arguments.done', item_id: item.id, output_index: index, arguments: raw })
    const finished = { ...item, arguments: raw, status: 'completed' }
    send({ type: 'response.output_item.done', output_index: index, item: finished })
    output.push(finished)
  }
  try {
    if (text.includes('LONGTEXT')) await streamText(longText(), 12, 15)
    else if (text.includes('MANYTOOLS')) {
      if (done < 40) {
        await streamText(`第 ${done + 1} 步。`, 20, 0)
        await callTool('bash', { command: `echo step ${done + 1}`, description: `step ${done + 1}` })
      } else await streamText('四十步都完成了。', 20, 10)
    } else if (text.includes('BIGOUT')) {
      if (done < 1) await callTool('bash', { command: 'for i in $(seq 1 6000); do echo "line $i ................................................................"; if [ $((i % 400)) -eq 0 ]; then sleep 0.25; fi; done', description: 'long output' })
      else await streamText('长输出结束。', 20, 10)
    } else if (text.includes('APPROVAL')) {
      if (done < 1) await callTool('bash', { command: 'reg delete "HKCU\\Software\\InkstoneApprovalTest" /f', description: 'approval probe' })
      else await streamText('审批测试结束。', 20, 10)
    } else await streamText('好的，收到。', 20, 10)
  } catch {}
  send({ type: 'response.completed', response: { id, status: 'completed', output, usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150, input_tokens_details: { cached_tokens: 0 } } } })
  res.end()
}

export function startFakeModel(port = 0) {
  const requests = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      let json = {}
      try { json = JSON.parse(body) } catch {}
      const input = Array.isArray(json.input) ? json.input : []
      const text = lastUserText(input)
      const done = toolOutputsSinceUser(input)
      requests.push({ at: Date.now(), text: text.slice(0, 40), done, tools: (json.tools ?? []).length })
      if (text.includes('FAIL')) {
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'fake upstream failure' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      void respond(res, text, done, requests.length)
    })
  })
  return new Promise((done) => server.listen(port, '127.0.0.1', () => done({ server, port: server.address().port, requests })))
}
